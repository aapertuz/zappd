from __future__ import annotations

import copy
import re
import struct
import sys
import zipfile
from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from pygltflib import FLOAT, GLTF2

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from catalog_specs import CATALOG_SPECS
from geometry_pipeline import parse_glb_diagnostics, parse_usdz_prim_paths, run_cad_pipeline
from material_skins import resolve_material_skin, srgb_hex_to_linear_rgba


EXPECTED_NODE_COUNTS = {
    "quadcopter_drone_v1": 30,
    "robotic_arm_3dof_v1": 24,
    "open_source_rover_v1": 15,
}


@pytest.mark.parametrize(
    ("color", "expected"),
    [
        ("#000000", [0, 0, 0, 1]),
        ("#ffffff", [1, 1, 1, 1]),
        ("#3f3f46", [0.049706566, 0.049706566, 0.061246054, 1]),
        ("#0a0b01", [0.003035270, 0.003346536, 0.000303527, 1]),
    ],
)
def test_catalog_srgb_is_converted_to_linear_color(color: str, expected: list[float]) -> None:
    assert srgb_hex_to_linear_rgba(color) == pytest.approx(expected, abs=1e-8)


def _read_glb_accessor(gltf: GLTF2, accessor_index: int, dimensions: int) -> np.ndarray:
    accessor = gltf.accessors[accessor_index]
    view = gltf.bufferViews[accessor.bufferView]
    return np.frombuffer(
        gltf.binary_blob(),
        dtype="<f4",
        count=accessor.count * dimensions,
        offset=(view.byteOffset or 0) + (accessor.byteOffset or 0),
    ).reshape(-1, dimensions)


def assert_glb_skins(glb_path: Path, nodes_spec: list[dict]) -> None:
    gltf = GLTF2.load_binary(str(glb_path))
    nodes_by_id = {node["id"]: node for node in nodes_spec}
    families = set()
    assert len(gltf.samplers) == 1
    sampler = gltf.samplers[0]
    assert (sampler.magFilter, sampler.minFilter, sampler.wrapS, sampler.wrapT) == (9729, 9987, 10497, 10497)
    assert "KHR_materials_clearcoat" in gltf.extensionsUsed

    for node in gltf.nodes:
        if node.mesh is None:
            continue
        spec = nodes_by_id[node.extras["componentId"]]
        skin = resolve_material_skin(spec["materialHint"])
        families.add(skin.family)
        for primitive in gltf.meshes[node.mesh].primitives:
            attributes = primitive.attributes
            uv_accessor = gltf.accessors[attributes.TEXCOORD_0]
            assert uv_accessor.type == "VEC2"
            assert uv_accessor.componentType == FLOAT
            assert uv_accessor.count == gltf.accessors[attributes.POSITION].count
            vertices = _read_glb_accessor(gltf, attributes.POSITION, 3)
            metric_uvs = _read_glb_accessor(gltf, attributes.TEXCOORD_0, 2) * skin.tile_size_meters
            assert np.isfinite(metric_uvs).all()
            assert np.all(np.ptp(metric_uvs, axis=0) > 0)
            projections = vertices[:, ((2, 1), (0, 2), (0, 1))]
            matches = np.isclose(metric_uvs[:, None, :], projections, atol=1e-7).all(axis=2)
            assert matches.any(axis=1).all()

            material = gltf.materials[primitive.material]
            pbr = material.pbrMetallicRoughness
            assert pbr.baseColorFactor == pytest.approx(srgb_hex_to_linear_rgba(spec["colorHex"]))
            assert pbr.metallicFactor == skin.metallic
            assert pbr.roughnessFactor == skin.roughness
            assert material.normalTexture.scale == skin.normal_scale
            assert material.extensions["KHR_materials_clearcoat"] == {
                "clearcoatFactor": skin.clearcoat,
                "clearcoatRoughnessFactor": skin.clearcoat_roughness,
            }
            for texture_info, suffix in (
                (pbr.baseColorTexture, "albedo"),
                (material.normalTexture, "normal"),
                (pbr.metallicRoughnessTexture, "metallic_roughness"),
            ):
                texture = gltf.textures[texture_info.index]
                assert texture.sampler == 0
                assert gltf.images[texture.source].name == f"{skin.family}_{suffix}"

    assert len(gltf.textures) == len(gltf.images) == 3 * len(families)
    blob = gltf.binary_blob()
    for image in gltf.images:
        assert image.uri is None
        assert image.mimeType == "image/png"
        view = gltf.bufferViews[image.bufferView]
        offset = view.byteOffset or 0
        assert offset % 4 == 0
        with Image.open(BytesIO(blob[offset : offset + view.byteLength])) as png:
            assert png.size == (256, 256)
            assert png.mode == "RGB"
            assert png.getextrema()[1][0] < png.getextrema()[1][1]


def assert_usdz_skins(usdz_path: Path, nodes_spec: list[dict]) -> None:
    leaves = [node for node in nodes_spec if node["level"] in ("component", "subcomponent")]
    families = {resolve_material_skin(node["materialHint"]).family for node in leaves}
    raw = usdz_path.read_bytes()
    with zipfile.ZipFile(usdz_path) as archive:
        names = archive.namelist()
        assert names[0] == "model.usda"
        assert len(names) == 1 + 3 * len(families)
        assert set(names[1:]) == {
            f"textures/{family}_{suffix}.png"
            for family in families
            for suffix in ("albedo", "normal", "roughness")
        }
        for info in archive.infolist():
            assert info.compress_type == zipfile.ZIP_STORED
            filename_size, extra_size = struct.unpack_from("<HH", raw, info.header_offset + 26)
            assert (info.header_offset + 30 + filename_size + extra_size) % 64 == 0
        for name in names[1:]:
            with Image.open(BytesIO(archive.read(name))) as png:
                assert png.size == (256, 256)
                assert png.mode == ("L" if name.endswith("_roughness.png") else "RGB")
                png.verify()
        usda = archive.read(names[0]).decode()

    assert usda.count('info:id = "UsdPreviewSurface"') == len(leaves)
    assert usda.count('info:id = "UsdPrimvarReader_float2"') == len(leaves)
    assert usda.count('info:id = "UsdUVTexture"') == 3 * len(leaves)
    assert usda.count('prepend apiSchemas = ["MaterialBindingAPI"]') == len(leaves)
    assert usda.count("texCoord2f[] primvars:st =") == len(leaves)
    assert usda.count("inputs:diffuseColor.connect") == len(leaves)
    assert usda.count("inputs:normal.connect") == len(leaves)
    assert usda.count("inputs:roughness.connect") == len(leaves)
    for node in leaves:
        cid = node["id"]
        assert f"rel material:binding = </World/Materials/mat_{cid}>" in usda
    assert set(re.findall(r"@\./(textures/[^@]+)@", usda)) == set(names[1:])


def test_all_robotics_categories_pass_opencascade_validation(tmp_path: Path) -> None:
    cache_dir = tmp_path / "step_cache"
    assert set(CATALOG_SPECS.keys()) == set(EXPECTED_NODE_COUNTS.keys())

    for archetype_id, spec in CATALOG_SPECS.items():
        out_dir = tmp_path / "exports" / archetype_id
        result = run_cad_pipeline(spec, output_dir=out_dir, cache_dir=cache_dir)

        assert len(result["nodes"]) == EXPECTED_NODE_COUNTS[archetype_id]
        validation = result["validation"]
        assert validation["valid"] is True, f"{archetype_id} failed: {validation['failures']}"
        assert validation["brepValid"] is True
        assert validation["interferenceCount"] == 0
        assert validation["maxDimensionalErrorMm"] <= 0.1
        assert validation["nodeMappingComplete"] is True
        assert validation["unitSystem"] == "meters_y_up"

        expected_leaf_ids = {
            n["id"] for n in spec["nodes"] if n["level"] in ("component", "subcomponent")
        }
        glb_ids, _ = parse_glb_diagnostics(out_dir / "model.glb")
        usda = parse_usdz_prim_paths(out_dir / "model.usdz")
        assert set(glb_ids) == expected_leaf_ids
        for cid in expected_leaf_ids:
            assert f'custom string componentId = "{cid}"' in usda

        assert_glb_skins(out_dir / "model.glb", spec["nodes"])
        assert_usdz_skins(out_dir / "model.usdz", spec["nodes"])

        for node in result["nodes"]:
            prov = node["provenance"]
            assert prov["origin"] == "open_step_catalog"
            assert prov["verificationStatus"] == "sourced_verified"
            assert prov["spdxLicense"]
            assert prov["sourceUrl"].startswith("https://")
            assert len(prov["stepSha256"]) == 64
            if node["level"] in ("component", "subcomponent"):
                assert node["specifications"]["brepFaces"] >= 4

        assert (out_dir / "model.step").stat().st_size > 0
        assert (out_dir / "model.glb").stat().st_size > 0
        assert (out_dir / "model.usdz").stat().st_size > 0


def test_collision_injection_rejects_and_marks_unverified(tmp_path: Path) -> None:
    cache_dir = tmp_path / "step_cache"
    out_dir = tmp_path / "collision_export"
    result = run_cad_pipeline(
        CATALOG_SPECS["quadcopter_drone_v1"],
        output_dir=out_dir,
        cache_dir=cache_dir,
        inject_collision_test=True,
    )
    assert result["validation"]["valid"] is False
    assert result["validation"]["interferenceCount"] >= 1
    assert result["verificationStatus"] == "unverified"
    for node in result["nodes"]:
        assert node["provenance"]["verificationStatus"] == "unverified"


def test_disallowed_fallback_origin_is_rejected(tmp_path: Path) -> None:
    cache_dir = tmp_path / "step_cache"
    out_dir = tmp_path / "invalid_origin_export"
    tampered = copy.deepcopy(CATALOG_SPECS["open_source_rover_v1"])
    for node in tampered["nodes"]:
        if node.get("stepFixtureName"):
            node["origin"] = "build123d_fallback"
            break
    with pytest.raises(RuntimeError, match="disallowed origin"):
        run_cad_pipeline(tampered, output_dir=out_dir, cache_dir=cache_dir)
