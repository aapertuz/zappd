from __future__ import annotations

import copy
import json
import re
import struct
import sys
import zipfile
from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.TopAbs import TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from pygltflib import FLOAT, GLTF2

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from catalog_ingestor import count_brep_faces, read_and_validate_step, read_xcaf_face_colors, resolve_component_step
from catalog_specs import CATALOG_SPECS, resolve_catalog_spec
from geometry_pipeline import parse_glb_diagnostics, parse_usdz_prim_paths, run_cad_pipeline, shape_bounds_mm
from material_skins import build_skin_texture_set, resolve_material_skin, srgb_hex_to_linear_rgba


EXPECTED_NODE_COUNTS = {
    "quadcopter_drone_v1": 30,
    "robotic_arm_3dof_v1": 24,
    "open_source_rover_v1": 15,
}
COTS_REGISTRY = (
    Path(__file__).resolve().parents[3] / "src/shared/domain/catalog/cots/index.json"
)


@pytest.fixture(scope="module")
def cots_parts() -> dict[str, dict]:
    return {part["cotsId"]: part for part in json.loads(COTS_REGISTRY.read_text(encoding="utf-8"))}


def test_worker_loads_complete_shared_catalog_specs() -> None:
    catalog_dir = Path(__file__).resolve().parents[3] / "src" / "shared" / "domain" / "catalog" / "assemblies"
    specs_from_disk = {
        path.stem: json.loads(path.read_text(encoding="utf-8"))
        for path in catalog_dir.glob("*.json")
    }
    assert list(CATALOG_SPECS) == list(EXPECTED_NODE_COUNTS)
    assert CATALOG_SPECS == specs_from_disk
    for archetype_id, spec in specs_from_disk.items():
        assert resolve_catalog_spec(archetype_id) == spec
        assert resolve_catalog_spec(archetype_id, str(catalog_dir / f"{archetype_id}.json")) == spec
        for node in spec["nodes"]:
            if node["stepFixtureName"] is not None:
                assert re.fullmatch(r"[a-f0-9]{64}", node["expectedStepSha256"])


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


@pytest.mark.parametrize(
    ("hint", "family"),
    [
        ("silicone_wire", "silicone_wire"),
        ("braided_sleeve", "braided_sleeve"),
        ("li_ion_battery", "composite_matte"),
    ],
)
def test_electronics_skin_resolution_and_textures(hint: str, family: str) -> None:
    skin = resolve_material_skin(hint)
    assert skin.family == family
    assert skin.metallic == 0
    textures = build_skin_texture_set(skin.family)
    for png in (textures.albedo_png, textures.normal_png, textures.metallic_roughness_png):
        with Image.open(BytesIO(png)) as image:
            assert image.size == (256, 256)
            assert image.mode == "RGB"
            assert image.getextrema()[1][0] < image.getextrema()[1][1]


def test_cots_registry_resolves_valid_centered_steps_with_ports(cots_parts: dict, tmp_path: Path) -> None:
    assert set(cots_parts) == {
        "cots_battery_3s_18650",
        "kicad_so100_bus_servo_adapter",
        "kicad_quad_4in1_esc",
        "kicad_quad_flight_controller",
        "kicad_quad_elrs_receiver",
        "kicad_nova2_jetson_carrier",
    }
    for cid, part in cots_parts.items():
        resolved = resolve_component_step({**part, "id": cid}, tmp_path)
        assert resolved["sha256"] == part["expectedStepSha256"]
        assert BRepCheck_Analyzer(resolved["shape"]).IsValid()
        assert resolved["faceCount"] == part["specifications"]["brepFaces"]
        lower, upper = np.asarray(shape_bounds_mm(resolved["shape"]))
        assert lower + upper == pytest.approx([0, 0, 0], abs=0.0001)
        assert upper - lower == pytest.approx(part["dimensionsMm"], abs=0.0001)

        face_colors = read_xcaf_face_colors(resolved["stepPath"])
        assert len(face_colors) == resolved["faceCount"]
        colors = {color for _, color in face_colors if color is not None}
        assert len(colors) == part["specifications"]["xcafColors"]
        assert len(colors) >= (3 if part["origin"] == "kicad_pcb_step" else 2)
        assert part["ports"]
        assert len({port["portId"] for port in part["ports"]}) == len(part["ports"])
        for port in part["ports"]:
            assert re.fullmatch(r"port_[a-z0-9_]+", port["portId"])
            assert port["label"] and port["connectorType"]
            assert port["busKind"] in {"dc_power", "usb_data", "ttl_serial", "i2c_spi_uart", "pwm_signal", "brushless_phase"}
            x, y, z = port["localPositionMeters"]
            position = np.array([x, -z, y]) * 1000
            assert np.all(position >= lower - 0.001)
            assert np.all(position <= upper + 0.001)
            assert np.linalg.norm(port["exitDirection"]) == pytest.approx(1)
            if cid == "kicad_quad_elrs_receiver":
                assert position[2] == pytest.approx(upper[2], abs=0.0001)
            if cid == "cots_battery_3s_18650":
                assert position[2] == pytest.approx(lower[2], abs=0.0001)


def test_xcaf_materials_export_as_one_component_with_partitioned_faces(cots_parts: dict, tmp_path: Path) -> None:
    board = "kicad_quad_elrs_receiver"
    cid = "comp_receiver"
    part = cots_parts[board]
    template = CATALOG_SPECS["open_source_rover_v1"]
    root = template["nodes"][0]
    component = next(node for node in template["nodes"] if node.get("stepFixtureName"))
    node = {
        **component,
        **part,
        "id": cid,
        "level": "component",
        "parentId": root["id"],
        "depth": 1,
        "restPositionMeters": [0, 0, 0],
    }
    out = tmp_path / "exports"
    cache = tmp_path / "steps"
    result = run_cad_pipeline({**template, "nodes": [root, node]}, output_dir=out, cache_dir=cache)
    assert result["verificationStatus"] == "composed_validated"
    assert result["validation"]["valid"]
    assert result["validation"]["maxDimensionalErrorMm"] <= 0.1

    glb = out / "model.glb"
    ids, bounds = parse_glb_diagnostics(glb)
    assert ids == [cid]
    gltf = GLTF2.load_binary(str(glb))
    meshes = [n for n in gltf.nodes if n.mesh is not None]
    assert [n.name for n in meshes] == [cid]
    primitives = gltf.meshes[meshes[0].mesh].primitives
    source_face_colors = read_xcaf_face_colors(cache / part["stepFixtureName"])
    tints = {tuple(srgb_hex_to_linear_rgba(color or part["colorHex"])) for _, color in source_face_colors}
    assert len(primitives) >= 3
    assert {tuple(gltf.materials[p.material].pbrMetallicRoughness.baseColorFactor) for p in primitives} == tints
    assert [gltf.materials[p.material].name for p in primitives] == [
        f"mat_{cid}_{index}" for index in range(len(primitives))
    ]
    points = np.concatenate([_read_glb_accessor(gltf, p.attributes.POSITION, 3) for p in primitives])
    assert bounds[cid][0] == pytest.approx(points.min(axis=0))
    assert bounds[cid][1] == pytest.approx(points.max(axis=0))

    usda = parse_usdz_prim_paths(out / "model.usdz")
    assert usda.count('def Mesh "Mesh"') == 1
    assert usda.count(f'custom string componentId = "{cid}"') == 2
    assert result["usdzPrimPaths"] == [f"/World/{root['id']}/{cid}"]
    assert 'uniform token subsetFamily:materialBind:familyType = "partition"' in usda
    assert usda.count('uniform token elementType = "face"') == len(primitives)
    subsets = re.findall(r'def GeomSubset "sub_(\d+)".*?int\[\] indices = \[(.*?)\]', usda, re.S)
    offset = 0
    for index, (subset, indices) in enumerate(subsets):
        assert int(subset) == index
        assert f'def Material "mat_{cid}_{index}"' in usda
        assert f"rel material:binding = </World/Materials/mat_{cid}_{index}>" in usda
        end = offset + gltf.accessors[primitives[index].indices].count // 3
        assert [int(face) for face in indices.split(", ")] == list(range(offset, end))
        offset = end
    assert len(subsets) == len(primitives)


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
        assert result["verificationStatus"] == "sourced_verified"
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


@pytest.mark.parametrize("has_geometry", [True, False])
def test_disallowed_fallback_origin_is_rejected(tmp_path: Path, has_geometry: bool) -> None:
    cache_dir = tmp_path / "step_cache"
    out_dir = tmp_path / "invalid_origin_export"
    tampered = copy.deepcopy(CATALOG_SPECS["open_source_rover_v1"])
    for node in tampered["nodes"]:
        if bool(node.get("stepFixtureName")) == has_geometry:
            node["origin"] = "build123d_fallback"
            break
    with pytest.raises(RuntimeError, match="disallowed origin"):
        run_cad_pipeline(tampered, output_dir=out_dir, cache_dir=cache_dir)


@pytest.mark.parametrize(
    ("origin", "source_url", "expected_status"),
    [
        ("open_step_catalog", "https://example.test/catalog.step", "sourced_verified"),
        ("cots_library_step", "https://example.test/connector.step", "sourced_verified"),
        ("kicad_pcb_step", "kicad://board/revision", "composed_validated"),
        ("kicad_pcb_step", "https://example.test/board.step", "composed_validated"),
        ("procedural_harness", "harness://catalog/route", "composed_validated"),
        ("procedural_harness", "https://example.test/harness.step", "composed_validated"),
        ("open_step_catalog", "kicad://board/revision", None),
        ("cots_library_step", "http://example.test/connector.step", None),
        ("kicad_pcb_step", "harness://catalog/route", None),
        ("procedural_harness", "kicad://board/revision", None),
    ],
)
def test_step_ingestion_enforces_origin_uri_and_status(
    tmp_path: Path, origin: str, source_url: str, expected_status: str | None
) -> None:
    rover_nodes = CATALOG_SPECS["open_source_rover_v1"]["nodes"]
    fixture_node = next(node for node in rover_nodes if node.get("stepFixtureName"))
    node = {**fixture_node, "origin": origin, "sourceUrl": source_url}
    if expected_status is None:
        with pytest.raises(RuntimeError, match="disallowed sourceUrl"):
            resolve_component_step(node, tmp_path)
    else:
        resolved = resolve_component_step(node, tmp_path)
        assert resolved["targetVerifiedStatus"] == expected_status
        assert resolved["sha256"] == node["expectedStepSha256"]


def test_mixed_geometry_uses_per_node_status_and_preserves_ports(tmp_path: Path) -> None:
    spec = copy.deepcopy(CATALOG_SPECS["open_source_rover_v1"])
    by_id = {node["id"]: node for node in spec["nodes"]}
    ports = [
        {
            "portId": "port_camera_usb",
            "label": "Camera data",
            "connectorType": "USB-C",
            "busKind": "usb_data",
            "localPositionMeters": [0.01, 0.02, 0],
            "exitDirection": [1, 0, 0],
        }
    ]
    by_id["comp_zed2i_stereo_camera"].update(
        origin="kicad_pcb_step", sourceUrl="kicad://test/board", ports=ports
    )
    by_id["sub_perception_avionics"].update(
        origin="procedural_harness", sourceUrl="harness://test/route"
    )

    result = run_cad_pipeline(spec, output_dir=tmp_path / "exports", cache_dir=tmp_path / "cache")

    assert result["validation"]["valid"] is True
    assert result["verificationStatus"] == "composed_validated"
    output_nodes = {node["id"]: node for node in result["nodes"]}
    assert output_nodes["comp_zed2i_stereo_camera"]["ports"] == ports
    for node_id, output_node in output_nodes.items():
        expected = "composed_validated" if node_id in {
            "comp_zed2i_stereo_camera", "sub_perception_avionics"
        } else "sourced_verified"
        assert output_node["provenance"]["verificationStatus"] == expected
        if node_id != "comp_zed2i_stereo_camera":
            assert "ports" not in output_node


@pytest.fixture
def harness_spec(cots_parts: dict):
    template = CATALOG_SPECS["open_source_rover_v1"]
    root = template["nodes"][0]
    component = next(node for node in template["nodes"] if node.get("stepFixtureName"))

    def board(cots_id: str, cid: str, position: list[float]) -> dict:
        return {
            **component, **cots_parts[cots_id], "id": cid, "parentId": root["id"],
            "level": "component", "depth": 1, "restPositionMeters": position,
        }

    def build(bus: str, collision: bool = False) -> dict:
        if bus == "usb_data":
            start = board("kicad_quad_flight_controller", "comp_from", [-0.055, 0, 0])
            end = board("kicad_so100_bus_servo_adapter", "comp_to", [0.055, 0, 0])
            from_port = to_port = "port_usb"
            waypoint = [0, 0.002, 0.05]
        elif bus == "dc_power":
            start = board("kicad_quad_4in1_esc", "comp_from", [-0.045, 0, 0])
            end = board("cots_battery_3s_18650", "comp_to", [0.090, 0.060, -0.008255])
            from_port, to_port = "port_dc_in", "port_tab_1"
            waypoint = [0.005, 0.030, 0.011]
        else:
            start = board("kicad_so100_bus_servo_adapter", "comp_from", [-0.050, 0, 0])
            end = board("kicad_so100_bus_servo_adapter", "comp_to", [0.060, 0, 0])
            from_port = to_port = "port_servo_1"
            waypoint = [0, 0.038, -0.0090875]
        relationship = {
            "id": "rel_cable", "fromComponentId": start["id"], "toComponentId": end["id"],
            "fromPortId": from_port, "toPortId": to_port,
            "connectionType": "power_bus" if bus == "dc_power" else "electrical_bus",
            "routingWaypointsMeters": [waypoint, [waypoint[0] + 0.0001, *waypoint[1:]]],
            "wireBundleDiameterMm": 3.5,
        }
        cable = {
            **component, "id": "comp_cable", "parentId": root["id"], "depth": 1,
            "level": "component", "origin": "procedural_harness", "sourceUrl": "harness://test/cable",
            "spdxLicense": "MIT", "stepFixtureName": "routed-cable.step", "expectedStepSha256": None,
            "colorHex": "#2468ac", "materialHint": "silicone_wire", "specifications": {"relationshipId": "rel_cable"},
            "restPositionMeters": [0.5, 0.5, 0.5], "dimensionsMm": [1, 1, 1],
        }
        nodes = [root, start, end, cable]
        if collision:
            crossbar = next(node for node in template["nodes"] if node["id"] == "subcomp_rover_crossbar")
            nodes.append({
                **crossbar, "id": "comp_obstruction", "parentId": root["id"],
                "level": "component", "depth": 1, "restPositionMeters": waypoint,
            })
        return {**template, "nodes": nodes, "relationships": [relationship]}

    return build


@pytest.mark.parametrize(("bus", "colors"), [
    ("usb_data", ["#2468ac"]),
    ("dc_power", ["#cc2929", "#222428"]),
    ("ttl_serial", ["#cc2929", "#222428", "#e5c158"]),
])
def test_routed_harness_exports_valid_colored_solids(harness_spec, bus, colors, tmp_path: Path) -> None:
    spec = harness_spec(bus)
    out = tmp_path / "exports"
    cache = tmp_path / "cache"
    result = run_cad_pipeline(spec, out, cache)
    validation = result["validation"]
    assert validation["valid"] is True, validation["failures"]
    assert validation["brepValid"] is True
    assert validation["interferenceCount"] == 0
    assert validation["maxDimensionalErrorMm"] <= 0.1
    assert validation["nodeMappingComplete"] is True
    assert result["verificationStatus"] == "composed_validated"
    node = next(node for node in result["nodes"] if node["id"] == "comp_cable")
    assert node["provenance"]["verificationStatus"] == "composed_validated"
    assert node["restPositionMeters"] != spec["nodes"][-1]["restPositionMeters"]

    step_path = cache / "routed-cable.step"
    step, digest, _ = read_and_validate_step(step_path)
    assert digest == node["provenance"]["stepSha256"]
    lower, upper = np.asarray(shape_bounds_mm(step))
    assert lower + upper == pytest.approx([0, 0, 0], abs=0.002)
    assert upper - lower == pytest.approx(node["dimensionsMm"], abs=0.002)
    solids = TopExp_Explorer(step, TopAbs_SOLID)
    solid_count = 0
    while solids.More():
        solid = solids.Current()
        assert BRepCheck_Analyzer(solid).IsValid()
        assert count_brep_faces(solid) >= 4
        solid_count += 1
        solids.Next()
    assert solid_count == len(colors)
    assert {color for _, color in read_xcaf_face_colors(step_path)} == set(colors)
    assert {color for _, color in read_xcaf_face_colors(out / "model.step") if color} == set(colors)

    gltf = GLTF2.load_binary(str(out / "model.glb"))
    glb_cable, = (item for item in gltf.nodes if item.extras["componentId"] == "comp_cable")
    assert glb_cable.translation == pytest.approx(node["restPositionMeters"], abs=1e-6)
    primitives = gltf.meshes[glb_cable.mesh].primitives
    assert len(primitives) == len(colors)
    glb_tints = [gltf.materials[primitive.material].pbrMetallicRoughness.baseColorFactor for primitive in primitives]
    expected_tints = [srgb_hex_to_linear_rgba(color) for color in colors]
    assert {tuple(tint) for tint in glb_tints} == {tuple(tint) for tint in expected_tints}

    usda = parse_usdz_prim_paths(out / "model.usdz")
    cable, = re.findall(r'def Xform "comp_cable"\n        \{(.*?)\n        \}', usda, re.S)
    assert cable.count('custom string componentId = "comp_cable"') == 2
    translation, = re.findall(r"double3 xformOp:translate = \((.*?)\)", cable)
    assert list(map(float, translation.split(", "))) == pytest.approx(node["restPositionMeters"], abs=1e-6)
    assert cable.count("def GeomSubset") == len(colors)
    for index, tint in enumerate(glb_tints):
        material_id = f"mat_comp_cable_{index}"
        assert f"rel material:binding = </World/Materials/{material_id}>" in cable
        material, = re.findall(rf'def Material "{material_id}"\n        \{{(.*?)\n        \}}', usda, re.S)
        albedo, = re.findall(r'def Shader "Albedo"\s*\{(.*?)\n            \}', material, re.S)
        scale, = re.findall(r"float4 inputs:scale = \((.*?)\)", albedo)
        assert list(map(float, scale.split(", "))) == pytest.approx(tint)

    repeated = run_cad_pipeline(spec, out, cache)
    repeat_node = next(item for item in repeated["nodes"] if item["id"] == node["id"])
    assert repeat_node["provenance"]["stepSha256"] == digest
    assert repeated["manifest"]["files"]["step"]["sha256"] == result["manifest"]["files"]["step"]["sha256"]


def test_routed_harness_interference_fails_validation(harness_spec, tmp_path: Path) -> None:
    result = run_cad_pipeline(harness_spec("ttl_serial", collision=True), tmp_path / "exports", tmp_path / "cache")
    assert result["verificationStatus"] == "unverified"
    assert result["validation"]["valid"] is False
    assert result["validation"]["brepValid"] is True
    assert result["validation"]["interferenceCount"] == 1
    assert any(
        "Volumetric interference between comp_cable and comp_obstruction" in failure
        for failure in result["validation"]["failures"]
    )


@pytest.mark.parametrize(("target", "field", "value", "failure"), [
    ("relationship", "fromPortId", None, "missing fromPortId"),
    ("relationship", "toPortId", "port_usb_missing", "no matching port on component 'comp_to'"),
    ("relationship", "connectionType", "assembly_mount", "requires an electrical relationship"),
    ("node", "specifications", {"relationshipId": "rel_missing"}, "no matching electrical relationship"),
    ("node", "sourceUrl", "kicad://test/cable", "disallowed sourceUrl"),
    ("node", "spdxLicense", "", "lacks SPDX license identifier"),
    ("node", "expectedStepSha256", "0" * 64, "STEP SHA-256 mismatch"),
])
def test_routed_harness_rejects_invalid_input(harness_spec, target, field, value, failure, tmp_path: Path) -> None:
    spec = harness_spec("usb_data")
    record = spec["relationships"][0] if target == "relationship" else spec["nodes"][-1]
    record[field] = value
    cache = tmp_path / "cache"
    with pytest.raises(RuntimeError, match=failure):
        run_cad_pipeline(spec, tmp_path / "exports", cache)
    assert not (cache / "routed-cable.step").exists()
