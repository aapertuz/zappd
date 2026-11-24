from __future__ import annotations

import datetime
import hashlib
import json
import struct
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Builder, BRep_Tool
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.GProp import GProp_GProps
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS, TopoDS_Compound
from OCP.gp import gp_Trsf, gp_Vec
from pygltflib import (
    ARRAY_BUFFER,
    ELEMENT_ARRAY_BUFFER,
    FLOAT,
    GLTF2,
    UNSIGNED_INT,
    Accessor,
    Buffer,
    BufferView,
    Image,
    Material,
    Mesh,
    Node,
    NormalMaterialTexture,
    PbrMetallicRoughness,
    Primitive,
    Sampler,
    Scene,
    Texture,
    TextureInfo,
)

from catalog_ingestor import MIN_CAD_BREP_FACES, resolve_component_step
from material_skins import (
    FAMILY_DEFAULTS,
    MaterialSkinSpec,
    SkinFamily,
    build_skin_texture_set,
    resolve_material_skin,
    srgb_hex_to_linear_rgba,
)


@dataclass(frozen=True)
class MeshGeometry:
    vertices: np.ndarray
    normals: np.ndarray
    indices: np.ndarray
    metric_uvs: np.ndarray


_UV_AXES = ((2, 1), (0, 2), (0, 1))
_ZIP_LOCAL_HEADER_BYTES = 30
_USDZ_ALIGNMENT_BYTES = 64


def world_rest_to_cad_mm(rest_m: list[float] | tuple[float, float, float]) -> tuple[float, float, float]:
    return (rest_m[0] * 1000.0, -rest_m[2] * 1000.0, rest_m[1] * 1000.0)


def translate_shape_mm(shape, offset_mm: tuple[float, float, float]):
    trsf = gp_Trsf()
    trsf.SetTranslation(gp_Vec(offset_mm[0], offset_mm[1], offset_mm[2]))
    return BRepBuilderAPI_Transform(shape, trsf, True).Shape()


def shape_bounds_mm(shape) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    box.SetGap(0.0)
    cmin = box.CornerMin()
    cmax = box.CornerMax()
    return (cmin.X(), cmin.Y(), cmin.Z()), (cmax.X(), cmax.Y(), cmax.Z())


def _project_face(
    vertices: np.ndarray,
    triangles: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    corners = vertices[triangles]
    face_normals = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
    lengths = np.linalg.norm(face_normals, axis=1, keepdims=True)
    unit_normals = face_normals / np.where(lengths > 1e-12, lengths, 1.0)
    vertex_normals = np.zeros_like(vertices)
    np.add.at(vertex_normals, triangles.ravel(), np.repeat(unit_normals, 3, axis=0))
    vertex_normals /= np.maximum(np.linalg.norm(vertex_normals, axis=1, keepdims=True), 1e-12)

    abs_normals = np.abs(face_normals)
    face_axis = int(np.argmax(np.abs(face_normals.sum(axis=0))))
    chart_axes = np.where(
        abs_normals[:, face_axis] >= lengths.ravel() * 0.45,
        face_axis,
        np.argmax(abs_normals, axis=1),
    )
    vertex_charts, indices = np.unique(
        np.column_stack((triangles.ravel(), np.repeat(chart_axes, 3))),
        axis=0,
        return_inverse=True,
    )
    chart_vertices = vertices[vertex_charts[:, 0]]
    chart_normals = vertex_normals[vertex_charts[:, 0]]
    uv_columns = np.asarray(_UV_AXES)[vertex_charts[:, 1]]
    metric_uvs = np.take_along_axis(chart_vertices, uv_columns, axis=1)
    return chart_vertices, chart_normals, indices.astype(np.uint32), metric_uvs


def tessellate_shape_meters_y_up(
    shape,
    linear_deflection: float = 0.2,
    angular_deflection: float = 0.4,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    BRepMesh_IncrementalMesh(shape, linear_deflection, False, angular_deflection, True)
    vertices: list[np.ndarray] = []
    normals: list[np.ndarray] = []
    indices: list[np.ndarray] = []
    metric_uvs: list[np.ndarray] = []
    vertex_offset = 0

    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face(explorer.Current())
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is not None and tri.NbTriangles() > 0:
            trsf = loc.Transformation()
            points = (tri.Node(idx).Transformed(trsf) for idx in range(1, tri.NbNodes() + 1))
            face_verts = np.array(
                [(point.X() / 1000.0, point.Z() / 1000.0, -point.Y() / 1000.0) for point in points],
                dtype=np.float32,
            )
            triangles = np.array(
                [tri.Triangle(idx).Get() for idx in range(1, tri.NbTriangles() + 1)],
                dtype=np.int32,
            ) - 1
            if face.Orientation() == 1:
                triangles = triangles[:, (0, 2, 1)]
            projected_vertices, projected_normals, projected_indices, projected_uvs = _project_face(
                face_verts, triangles
            )
            vertices.append(projected_vertices)
            normals.append(projected_normals)
            indices.append(projected_indices + vertex_offset)
            metric_uvs.append(projected_uvs)
            vertex_offset += len(projected_vertices)
        explorer.Next()

    if not vertices:
        return (
            np.empty((0, 3), dtype=np.float32),
            np.empty((0, 3), dtype=np.float32),
            np.empty(0, dtype=np.uint32),
            np.empty((0, 2), dtype=np.float32),
        )
    return np.concatenate(vertices), np.concatenate(normals), np.concatenate(indices), np.concatenate(metric_uvs)


def _append_glb_buffer_view(
    gltf: GLTF2,
    blob: bytearray,
    payload: bytes,
    target: int | None = None,
) -> int:
    index = len(gltf.bufferViews)
    gltf.bufferViews.append(
        BufferView(buffer=0, byteOffset=len(blob), byteLength=len(payload), target=target)
    )
    blob.extend(payload)
    blob.extend(b"\x00" * (-len(payload) % 4))
    return index


def _append_glb_accessor(
    gltf: GLTF2,
    blob: bytearray,
    values: np.ndarray,
    kind: str,
    *,
    position_bounds: bool = False,
) -> int:
    is_index = kind == "SCALAR"
    payload = values.astype("<u4" if is_index else "<f4", copy=False).tobytes()
    view = _append_glb_buffer_view(gltf, blob, payload, ELEMENT_ARRAY_BUFFER if is_index else ARRAY_BUFFER)
    index = len(gltf.accessors)
    gltf.accessors.append(
        Accessor(
            bufferView=view,
            componentType=UNSIGNED_INT if is_index else FLOAT,
            count=len(values),
            type=kind,
            min=values.min(axis=0).tolist() if position_bounds else [],
            max=values.max(axis=0).tolist() if position_bounds else [],
        )
    )
    return index


def _append_glb_skin_textures(gltf: GLTF2, blob: bytearray, family: SkinFamily) -> tuple[int, int, int]:
    if not gltf.samplers:
        gltf.samplers.append(Sampler(magFilter=9729, minFilter=9987, wrapS=10497, wrapT=10497))
    textures = build_skin_texture_set(family)
    start = len(gltf.textures)
    for name, png in (
        ("albedo", textures.albedo_png),
        ("normal", textures.normal_png),
        ("metallic_roughness", textures.metallic_roughness_png),
    ):
        image_index = len(gltf.images)
        view = _append_glb_buffer_view(gltf, blob, png)
        gltf.images.append(Image(name=f"{family}_{name}", bufferView=view, mimeType="image/png"))
        gltf.textures.append(Texture(sampler=0, source=image_index))
    return start, start + 1, start + 2


def export_hierarchical_glb(
    nodes_spec: list[dict[str, Any]],
    geometry_by_id: dict[str, MeshGeometry],
    verification_status: str,
    out_path: Path,
) -> list[str]:
    gltf = GLTF2(scene=0, scenes=[Scene(nodes=[0])], nodes=[], meshes=[], materials=[], accessors=[], bufferViews=[], buffers=[])
    binary_blob = bytearray()
    index_by_id: dict[str, int] = {}
    rest_by_id: dict[str, list[float]] = {}
    exported_leaf_ids: list[str] = []
    textures_by_family: dict[SkinFamily, tuple[int, int, int]] = {}

    for idx, node_spec in enumerate(nodes_spec):
        index_by_id[node_spec["id"]] = idx
        rest_by_id[node_spec["id"]] = list(node_spec["restPositionMeters"])

    children_by_id: dict[str, list[int]] = {n["id"]: [] for n in nodes_spec}
    for idx, node_spec in enumerate(nodes_spec):
        pid = node_spec["parentId"]
        if pid is not None and pid in children_by_id:
            children_by_id[pid].append(idx)

    for node_spec in nodes_spec:
        cid = node_spec["id"]
        pid = node_spec["parentId"]
        rest = rest_by_id[cid]
        parent_rest = rest_by_id[pid] if pid is not None and pid in rest_by_id else [0.0, 0.0, 0.0]
        local_translation = [
            round(rest[0] - parent_rest[0], 6),
            round(rest[1] - parent_rest[1], 6),
            round(rest[2] - parent_rest[2], 6),
        ]

        extras = {
            "componentId": cid,
            "parentId": pid,
            "level": node_spec["level"],
            "depth": node_spec["depth"],
            "explodeDirection": list(node_spec["explodeDirection"]),
            "explodeDistanceMeters": node_spec["explodeDistanceMeters"],
            "verificationStatus": verification_status,
            "spdxLicense": node_spec["spdxLicense"],
            "materialHint": node_spec["materialHint"],
        }

        mesh_index = None
        if cid in geometry_by_id:
            geom = geometry_by_id[cid]
            skin = resolve_material_skin(node_spec["materialHint"])
            if skin.family not in textures_by_family:
                textures_by_family[skin.family] = _append_glb_skin_textures(gltf, binary_blob, skin.family)
            albedo, normal, metallic_roughness = textures_by_family[skin.family]

            mat_idx = len(gltf.materials)
            gltf.materials.append(
                Material(
                    name=f"mat_{cid}",
                    pbrMetallicRoughness=PbrMetallicRoughness(
                        baseColorFactor=srgb_hex_to_linear_rgba(node_spec["colorHex"]),
                        baseColorTexture=TextureInfo(index=albedo),
                        metallicFactor=skin.metallic,
                        roughnessFactor=skin.roughness,
                        metallicRoughnessTexture=TextureInfo(index=metallic_roughness),
                    ),
                    normalTexture=NormalMaterialTexture(index=normal, scale=skin.normal_scale),
                    extensions={
                        "KHR_materials_clearcoat": {
                            "clearcoatFactor": skin.clearcoat,
                            "clearcoatRoughnessFactor": skin.clearcoat_roughness,
                        },
                    },
                )
            )

            pos_acc_idx = _append_glb_accessor(gltf, binary_blob, geom.vertices, "VEC3", position_bounds=True)
            norm_acc_idx = _append_glb_accessor(gltf, binary_blob, geom.normals, "VEC3")
            uv_acc_idx = _append_glb_accessor(gltf, binary_blob, geom.metric_uvs / skin.tile_size_meters, "VEC2")
            idx_acc_idx = _append_glb_accessor(gltf, binary_blob, geom.indices, "SCALAR")

            mesh_index = len(gltf.meshes)
            gltf.meshes.append(
                Mesh(
                    name=f"mesh_{cid}",
                    primitives=[
                        Primitive(
                            attributes={"POSITION": pos_acc_idx, "NORMAL": norm_acc_idx, "TEXCOORD_0": uv_acc_idx},
                            indices=idx_acc_idx,
                            material=mat_idx,
                        )
                    ],
                )
            )
            exported_leaf_ids.append(cid)

        gltf.nodes.append(
            Node(
                name=cid,
                children=children_by_id[cid],
                translation=local_translation,
                mesh=mesh_index,
                extras=extras,
            )
        )

    if gltf.materials:
        gltf.extensionsUsed = ["KHR_materials_clearcoat"]
    gltf.buffers = [Buffer(byteLength=len(binary_blob))]
    gltf.set_binary_blob(bytes(binary_blob))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    gltf.save_binary(str(out_path))
    return exported_leaf_ids


def _prim_path_map(nodes_spec: list[dict[str, Any]]) -> dict[str, str]:
    by_id = {n["id"]: n for n in nodes_spec}
    paths: dict[str, str] = {}
    for n in nodes_spec:
        parts: list[str] = []
        cursor: dict[str, Any] | None = n
        while cursor is not None:
            parts.append(cursor["id"])
            pid = cursor["parentId"]
            cursor = by_id.get(pid) if pid is not None else None
        paths[n["id"]] = "/World/" + "/".join(reversed(parts))
    return paths


def _usda_uv_texture(
    material_path: str,
    family: SkinFamily,
    shader_name: str,
    texture_name: str,
    color_space: str,
    scale: tuple[float, float, float, float],
    fallback: tuple[float, float, float, float],
    output: str = "float3 outputs:rgb",
    bias: tuple[float, float, float, float] = (0, 0, 0, 0),
) -> str:
    return f'''            def Shader "{shader_name}"
            {{
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./textures/{family}_{texture_name}.png@
                float2 inputs:st.connect = <{material_path}/PrimvarReader.outputs:result>
                token inputs:sourceColorSpace = "{color_space}"
                token inputs:wrapS = "repeat"
                token inputs:wrapT = "repeat"
                float4 inputs:scale = {scale}
                float4 inputs:bias = {bias}
                float4 inputs:fallback = {fallback}
                {output}
            }}'''


def _usda_material(cid: str, tint: list[float], skin: MaterialSkinSpec) -> str:
    material_path = f"/World/Materials/mat_{cid}"
    family = skin.family
    nominal_roughness = FAMILY_DEFAULTS[family].roughness
    roughness_scale = skin.roughness / nominal_roughness
    rgb = tuple(round(channel, 8) for channel in tint[:3])
    albedo = _usda_uv_texture(material_path, family, "Albedo", "albedo", "sRGB", (*rgb, 1), (1, 1, 1, 1))
    normal = _usda_uv_texture(
        material_path, family, "Normal", "normal", "raw",
        (2, 2, 2, 1), (0.5, 0.5, 1, 1), bias=(-1, -1, -1, 0),
    )
    roughness = _usda_uv_texture(
        material_path, family, "Roughness", "roughness", "raw",
        (roughness_scale, roughness_scale, roughness_scale, 1),
        (nominal_roughness, nominal_roughness, nominal_roughness, 1),
        output="float outputs:r",
    )
    return f'''        def Material "mat_{cid}"
        {{
            token outputs:surface.connect = <{material_path}/PBRShader.outputs:surface>

            def Shader "PBRShader"
            {{
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor.connect = <{material_path}/Albedo.outputs:rgb>
                normal3f inputs:normal.connect = <{material_path}/Normal.outputs:rgb>
                float inputs:roughness.connect = <{material_path}/Roughness.outputs:r>
                float inputs:metallic = {skin.metallic}
                float inputs:clearcoat = {skin.clearcoat}
                float inputs:clearcoatRoughness = {skin.clearcoat_roughness}
                token outputs:surface
            }}

            def Shader "PrimvarReader"
            {{
                uniform token info:id = "UsdPrimvarReader_float2"
                string inputs:varname = "st"
                float2 outputs:result
            }}

{albedo}

{normal}

{roughness}
        }}'''


def _write_usdz_entry(archive: zipfile.ZipFile, file_name: str, payload: bytes) -> None:
    info = zipfile.ZipInfo(file_name)
    extra_header_size = struct.calcsize("<HH")
    data_offset = archive.start_dir + _ZIP_LOCAL_HEADER_BYTES + len(file_name.encode("utf-8")) + extra_header_size
    padding = -data_offset % _USDZ_ALIGNMENT_BYTES
    info.extra = struct.pack("<HH", 0x1986, padding) + bytes(padding)
    archive.writestr(info, payload)


def export_usdz_archive(
    nodes_spec: list[dict[str, Any]],
    geometry_by_id: dict[str, MeshGeometry],
    out_path: Path,
) -> dict[str, str]:
    by_id = {n["id"]: n for n in nodes_spec}
    children_map: dict[str | None, list[dict[str, Any]]] = {}
    for n in nodes_spec:
        children_map.setdefault(n["parentId"], []).append(n)

    materials: dict[str, tuple[list[float], MaterialSkinSpec]] = {
        cid: (
            srgb_hex_to_linear_rgba(by_id[cid]["colorHex"]),
            resolve_material_skin(by_id[cid]["materialHint"]),
        )
        for cid in geometry_by_id
    }
    prim_paths = _prim_path_map(nodes_spec)
    lines: list[str] = [
        "#usda 1.0",
        "(",
        '    defaultPrim = "World"',
        "    metersPerUnit = 1.0",
        '    upAxis = "Y"',
        ")",
        "",
        'def Xform "World"',
        "{",
        '    def Scope "Materials"',
        "    {",
        *(_usda_material(cid, tint, skin) for cid, (tint, skin) in materials.items()),
        "    }",
        "",
    ]

    def emit_node(node: dict[str, Any], indent: int) -> None:
        pad = " " * indent
        cid = node["id"]
        pid = node["parentId"]
        rest = node["restPositionMeters"]
        p_rest = by_id[pid]["restPositionMeters"] if pid is not None and pid in by_id else [0.0, 0.0, 0.0]
        dx, dy, dz = (round(coord - parent_coord, 6) for coord, parent_coord in zip(rest, p_rest))
        lines.extend([
            f'{pad}def Xform "{cid}"',
            f"{pad}{{",
            f"{pad}    double3 xformOp:translate = ({dx}, {dy}, {dz})",
            f'{pad}    uniform token[] xformOpOrder = ["xformOp:translate"]',
            f'{pad}    custom string componentId = "{cid}"',
        ])

        if cid in geometry_by_id:
            geom = geometry_by_id[cid]
            rgba, skin = materials[cid]
            uv = geom.metric_uvs / skin.tile_size_meters
            pts_str = ", ".join(f"({x:.6f}, {y:.6f}, {z:.6f})" for x, y, z in geom.vertices)
            norms_str = ", ".join(f"({x:.5f}, {y:.5f}, {z:.5f})" for x, y, z in geom.normals)
            uv_str = ", ".join(f"({u:.6f}, {1.0 - v:.6f})" for u, v in uv)
            face_counts = ", ".join(["3"] * (len(geom.indices) // 3))
            face_indices = ", ".join(str(int(i)) for i in geom.indices)
            lines.extend([
                f'{pad}    def Mesh "Mesh" (',
                f'{pad}        prepend apiSchemas = ["MaterialBindingAPI"]',
                f'{pad}    )',
                f"{pad}    {{",
                f'{pad}        uniform token subdivisionScheme = "none"',
                f"{pad}        int[] faceVertexCounts = [{face_counts}]",
                f"{pad}        int[] faceVertexIndices = [{face_indices}]",
                f"{pad}        point3f[] points = [{pts_str}]",
                f'{pad}        normal3f[] normals = [{norms_str}] (interpolation = "vertex")',
                f'{pad}        texCoord2f[] primvars:st = [{uv_str}] (interpolation = "vertex")',
                f"{pad}        color3f[] primvars:displayColor = [({rgba[0]:.8g}, {rgba[1]:.8g}, {rgba[2]:.8g})]",
                f'{pad}        custom string componentId = "{cid}"',
                f"{pad}        rel material:binding = </World/Materials/mat_{cid}>",
                f"{pad}    }}",
            ])

        for child in children_map.get(cid, []):
            emit_node(child, indent + 4)
        lines.append(f"{pad}}}")

    for root in children_map.get(None, []):
        emit_node(root, 4)
    lines.append("}")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, mode="w", compression=zipfile.ZIP_STORED) as archive:
        _write_usdz_entry(archive, "model.usda", ("\n".join(lines) + "\n").encode("utf-8"))
        families = dict.fromkeys(skin.family for _, skin in materials.values())
        for family in families:
            textures = build_skin_texture_set(family)
            _write_usdz_entry(archive, f"textures/{family}_albedo.png", textures.albedo_png)
            _write_usdz_entry(archive, f"textures/{family}_normal.png", textures.usd_normal_png)
            _write_usdz_entry(archive, f"textures/{family}_roughness.png", textures.roughness_gray_png)

    return prim_paths


def parse_glb_diagnostics(glb_path: Path) -> tuple[list[str], dict[str, tuple[list[float], list[float]]]]:
    raw = glb_path.read_bytes()
    if raw[:4] != b"glTF":
        raise RuntimeError(f"Invalid GLB header in {glb_path}")
    chunk_len, chunk_type = struct.unpack("<II", raw[12:20])
    if chunk_type != 0x4E4F534A:
        raise RuntimeError(f"Expected JSON chunk first in {glb_path}")
    gltf_json = json.loads(raw[20 : 20 + chunk_len].decode("utf-8"))
    nodes = gltf_json.get("nodes", [])
    meshes = gltf_json.get("meshes", [])
    accessors = gltf_json.get("accessors", [])

    node_ids: list[str] = []
    bounds_by_id: dict[str, tuple[list[float], list[float]]] = {}
    for node in nodes:
        extras = node.get("extras") or {}
        cid = extras.get("componentId")
        if cid is not None and "mesh" in node and node["mesh"] is not None:
            node_ids.append(cid)
            mesh = meshes[node["mesh"]]
            pos_acc_idx = mesh["primitives"][0]["attributes"]["POSITION"]
            acc = accessors[pos_acc_idx]
            bounds_by_id[cid] = (acc["min"], acc["max"])
    return node_ids, bounds_by_id


def parse_usdz_prim_paths(usdz_path: Path) -> str:
    with zipfile.ZipFile(usdz_path, mode="r") as zf:
        return zf.read("model.usda").decode("utf-8")


def _validate_node_provenance(node_spec: dict[str, Any]) -> str | None:
    cid = node_spec["id"]
    if node_spec.get("origin") != "open_step_catalog":
        return f"Node {cid} origin is not open_step_catalog"
    source_url = str(node_spec.get("sourceUrl", ""))
    if not source_url.startswith("https://"):
        return f"Node {cid} lacks verified HTTPS sourceUrl"
    spdx_license = str(node_spec.get("spdxLicense", "")).strip()
    if not spdx_license:
        return f"Node {cid} lacks SPDX license identifier"
    return None


def run_cad_pipeline(
    archetype_spec: dict[str, Any],
    output_dir: Path,
    cache_dir: Path,
    inject_collision_test: bool = False,
) -> dict[str, Any]:
    archetype_id = archetype_spec["archetypeId"]
    nodes_spec = list(archetype_spec["nodes"])
    failures: list[str] = []

    ingested: dict[str, dict[str, Any]] = {}
    placed_solids: dict[str, Any] = {}
    geometry_by_id: dict[str, MeshGeometry] = {}
    max_dim_err_mm = 0.0
    brep_valid = True

    compound = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(compound)

    for idx, node_spec in enumerate(nodes_spec):
        cid = node_spec["id"]
        provenance_failure = _validate_node_provenance(node_spec)
        if provenance_failure is not None:
            failures.append(provenance_failure)

        resolved = resolve_component_step(node_spec, cache_dir)
        if not resolved["hasGeometry"]:
            continue

        if resolved["faceCount"] < MIN_CAD_BREP_FACES:
            failures.append(
                f"Component {cid} has {resolved['faceCount']} faces (< {MIN_CAD_BREP_FACES})"
            )

        shape = resolved["shape"]
        if not BRepCheck_Analyzer(shape).IsValid():
            brep_valid = False
            failures.append(f"Invalid BRep solid for {cid}")

        rest_m = list(node_spec["restPositionMeters"])
        if inject_collision_test and idx == len(nodes_spec) - 1:
            first_geom_node = next(n for n in nodes_spec if n.get("stepFixtureName") is not None)
            rest_m = list(first_geom_node["restPositionMeters"])

        cad_offset_mm = world_rest_to_cad_mm(rest_m)
        placed_shape = translate_shape_mm(shape, cad_offset_mm)
        placed_solids[cid] = placed_shape
        builder.Add(compound, placed_shape)

        verts, norms, idxs, metric_uvs = tessellate_shape_meters_y_up(shape)
        if len(verts) == 0 or len(idxs) == 0:
            failures.append(f"Empty triangulation for {cid}")
        else:
            bmin_mm, bmax_mm = shape_bounds_mm(shape)
            mesh_min_mm = np.array([verts[:, 0].min(), -verts[:, 2].max(), verts[:, 1].min()]) * 1000.0
            mesh_max_mm = np.array([verts[:, 0].max(), -verts[:, 2].min(), verts[:, 1].max()]) * 1000.0
            step_min_mm = np.array([bmin_mm[0], bmin_mm[1], bmin_mm[2]])
            step_max_mm = np.array([bmax_mm[0], bmax_mm[1], bmax_mm[2]])
            err_mm = float(max(np.max(np.abs(mesh_min_mm - step_min_mm)), np.max(np.abs(mesh_max_mm - step_max_mm))))
            max_dim_err_mm = max(max_dim_err_mm, err_mm)
            if err_mm > 0.1:
                failures.append(f"Dimensional tolerance exceeded for {cid}: {err_mm:.4f} mm > 0.1 mm")

            geometry_by_id[cid] = MeshGeometry(verts, norms, idxs, metric_uvs)
        ingested[cid] = resolved

    interference_count = 0
    solid_ids = list(placed_solids.keys())
    for i in range(len(solid_ids)):
        for j in range(i + 1, len(solid_ids)):
            id_a = solid_ids[i]
            id_b = solid_ids[j]
            bmin_a, bmax_a = shape_bounds_mm(placed_solids[id_a])
            bmin_b, bmax_b = shape_bounds_mm(placed_solids[id_b])
            if (
                bmin_a[0] >= bmax_b[0]
                or bmax_a[0] <= bmin_b[0]
                or bmin_a[1] >= bmax_b[1]
                or bmax_a[1] <= bmin_b[1]
                or bmin_a[2] >= bmax_b[2]
                or bmax_a[2] <= bmin_b[2]
            ):
                continue
            common = BRepAlgoAPI_Common(placed_solids[id_a], placed_solids[id_b]).Shape()
            props = GProp_GProps()
            BRepGProp.VolumeProperties_s(common, props)
            vol = float(props.Mass())
            if vol > 1e-3:
                interference_count += 1
                failures.append(f"Volumetric interference between {id_a} and {id_b}: {vol:.4f} mm^3")

    output_dir.mkdir(parents=True, exist_ok=True)
    step_out = output_dir / "model.step"
    glb_out = output_dir / "model.glb"
    usdz_out = output_dir / "model.usdz"

    step_writer = STEPControl_Writer()
    step_writer.Transfer(compound, STEPControl_AsIs)
    step_writer.Write(str(step_out))

    all_checks_ok = brep_valid and interference_count == 0 and max_dim_err_mm <= 0.1 and len(failures) == 0
    project_status = "sourced_verified" if all_checks_ok else "unverified"

    exported_glb_ids = export_hierarchical_glb(nodes_spec, geometry_by_id, project_status, glb_out)
    prim_paths = export_usdz_archive(nodes_spec, geometry_by_id, usdz_out)

    parsed_glb_ids, _ = parse_glb_diagnostics(glb_out)
    usda_text = parse_usdz_prim_paths(usdz_out)

    expected_leaf_ids = [n["id"] for n in nodes_spec if n["level"] in ("component", "subcomponent")]
    glb_mapping_ok = set(expected_leaf_ids) == set(parsed_glb_ids) == set(exported_glb_ids)
    usdz_mapping_ok = all(f'custom string componentId = "{cid}"' in usda_text for cid in expected_leaf_ids)
    node_mapping_complete = glb_mapping_ok and usdz_mapping_ok
    if not node_mapping_complete:
        failures.append("Incomplete 1:1 componentId mapping across Firestore, GLB, and USDZ")

    valid = all_checks_ok and node_mapping_complete
    final_status = "sourced_verified" if valid else "unverified"

    step_bytes = step_out.read_bytes()
    glb_bytes = glb_out.read_bytes()
    usdz_bytes = usdz_out.read_bytes()

    step_sha = hashlib.sha256(step_bytes).hexdigest()
    glb_sha = hashlib.sha256(glb_bytes).hexdigest()
    usdz_sha = hashlib.sha256(usdz_bytes).hexdigest()
    manifest_hash = hashlib.sha256(f"{archetype_id}:{step_sha}:{glb_sha}:{usdz_sha}".encode("utf-8")).hexdigest()
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

    enriched_nodes: list[dict[str, Any]] = []
    for node_spec in nodes_spec:
        cid = node_spec["id"]
        if cid in ingested:
            node_status = ingested[cid]["targetVerifiedStatus"] if valid else "unverified"
            node_sha = ingested[cid]["sha256"]
        else:
            node_status = final_status
            node_sha = step_sha

        enriched_nodes.append(
            {
                "id": cid,
                "parentId": node_spec["parentId"],
                "name": node_spec["name"],
                "level": node_spec["level"],
                "depth": node_spec["depth"],
                "category": node_spec["category"],
                "colorHex": node_spec["colorHex"],
                "dimensionsMm": node_spec["dimensionsMm"],
                "restPositionMeters": node_spec["restPositionMeters"],
                "explodeDirection": node_spec["explodeDirection"],
                "explodeDistanceMeters": node_spec["explodeDistanceMeters"],
                "materialHint": node_spec["materialHint"],
                "specifications": node_spec["specifications"],
                "provenance": {
                    "origin": node_spec["origin"],
                    "verificationStatus": node_status,
                    "spdxLicense": node_spec["spdxLicense"],
                    "sourceUrl": node_spec["sourceUrl"],
                    "sourceName": node_spec["sourceName"],
                    "stepSha256": node_sha,
                },
                "glbNodeName": cid,
                "usdzPrimPath": prim_paths[cid],
            }
        )

    manifest = {
        "manifestHash": manifest_hash,
        "archetypeId": archetype_id,
        "generatedAtIso": now_iso,
        "files": {
            "step": {
                "format": "step",
                "storagePath": f"assemblies/{manifest_hash}/model.step",
                "publicUrl": f"/assemblies/{archetype_id}/model.step",
                "sha256": step_sha,
                "sizeBytes": len(step_bytes),
            },
            "glb": {
                "format": "glb",
                "storagePath": f"assemblies/{manifest_hash}/model.glb",
                "publicUrl": f"/assemblies/{archetype_id}/model.glb",
                "sha256": glb_sha,
                "sizeBytes": len(glb_bytes),
            },
            "usdz": {
                "format": "usdz",
                "storagePath": f"assemblies/{manifest_hash}/model.usdz",
                "publicUrl": f"/assemblies/{archetype_id}/model.usdz",
                "sha256": usdz_sha,
                "sizeBytes": len(usdz_bytes),
            },
        },
    }

    validation = {
        "valid": valid,
        "brepValid": brep_valid,
        "interferenceCount": interference_count,
        "maxDimensionalErrorMm": round(max_dim_err_mm, 5),
        "nodeMappingComplete": node_mapping_complete,
        "unitSystem": "meters_y_up",
        "checkedAtIso": now_iso,
        "failures": failures,
    }

    result = {
        "archetypeId": archetype_id,
        "verificationStatus": final_status,
        "nodes": enriched_nodes,
        "manifest": manifest,
        "validation": validation,
        "glbNodeIds": parsed_glb_ids,
        "usdzPrimPaths": [prim_paths[cid] for cid in expected_leaf_ids],
    }

    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (output_dir / "pipeline_result.json").write_text(json.dumps(result, indent=2))
    return result
