from __future__ import annotations

import datetime
from collections import Counter
import hashlib
import json
import re
import struct
import zipfile
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter
from typing import Any

import numpy as np
from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Builder, BRep_Tool
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_Transform
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepGProp import BRepGProp
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepTools import BRepTools
from OCP.GProp import GProp_GProps
from OCP.IMeshTools import IMeshTools_Parameters
from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Shape
from OCP.collections import List_TopoDS_Shape
from OCP.gp import gp_Dir, gp_Pln, gp_Pnt, gp_Trsf, gp_Vec
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

from cable_router import CableRoutingBlockedError, route_harness_for_node, write_colored_step
from cad_pose import local_pose, node_transform, place_shape, world_rest_to_cad_mm
from catalog_ingestor import GEOMETRY_ORIGIN_POLICY, InvalidBRepError, resolve_component_step
from validation_checks import (
    INTERFERENCE_TOLERANCE_MM3,
    electrical_failures,
    extract_face_boxes,
    extract_solid_probes,
    floating_components,
    solids_may_intersect,
)
from xbf_cache import DEFAULT_XBF_DIR, CadAssetCache, CacheMode, build_cache_mode
from material_skins import (
    FAMILY_DEFAULTS,
    MaterialSkinSpec,
    SkinFamily,
    build_skin_texture_set,
    resolve_material_skin,
    srgb_hex_to_linear_rgba,
)
from trimmed_bounds import trimmed_shape_bounds_mm


@dataclass(frozen=True)
class MeshPrimitiveGeometry:
    vertices: np.ndarray
    normals: np.ndarray
    indices: np.ndarray
    metric_uvs: np.ndarray
    color_hex: str | None = None
    material_hint: str | None = None


@dataclass(frozen=True)
class MeshGeometry:
    vertices: np.ndarray
    normals: np.ndarray
    indices: np.ndarray
    metric_uvs: np.ndarray
    primitives: tuple[MeshPrimitiveGeometry, ...] = ()


_UV_AXES = ((2, 1), (0, 2), (0, 1))
_ZIP_LOCAL_HEADER_BYTES = 30
_USDZ_ALIGNMENT_BYTES = 64
_HARNESS_MIN_MESH_SIZE_MM = 0.2


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


def interference_volume_mm3(first: TopoDS_Shape, second: TopoDS_Shape) -> float:
    arguments = List_TopoDS_Shape()
    arguments.Append(first)
    tools = List_TopoDS_Shape()
    tools.Append(second)
    common = BRepAlgoAPI_Common()
    common.SetArguments(arguments)
    common.SetTools(tools)
    common.SetUseOBB(True)
    common.SetRunParallel(True)
    common.Build()
    if not common.IsDone():
        raise RuntimeError("OpenCascade boolean interference check failed")
    properties = GProp_GProps()
    BRepGProp.VolumeProperties_s(common.Shape(), properties)
    return float(properties.Mass())


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
    min_mesh_size_mm: float = -1.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    parameters = IMeshTools_Parameters()
    parameters.Deflection = linear_deflection
    parameters.Angle = angular_deflection
    parameters.MinSize = min_mesh_size_mm
    parameters.InParallel = True
    BRepMesh_IncrementalMesh(shape, parameters)
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


def _exact_axis_extent_mm(
    shape: TopoDS_Shape, axis: int, upper: bool, lower_bounds: np.ndarray, upper_bounds: np.ndarray,
) -> float:
    span = float(max(upper_bounds - lower_bounds)) + 100.0
    offset = 10.0
    origin = [0.0, 0.0, 0.0]
    normal = [0.0, 0.0, 0.0]
    origin[axis] = float(upper_bounds[axis] + offset) if upper else float(lower_bounds[axis] - offset)
    normal[axis] = -1.0 if upper else 1.0
    plane = BRepBuilderAPI_MakeFace(
        gp_Pln(gp_Pnt(*origin), gp_Dir(*normal)), -span, span, -span, span,
    ).Face()
    extrema = BRepExtrema_DistShapeShape(shape, plane)
    extrema.Perform()
    if not extrema.IsDone() or extrema.NbSolution() < 1:
        return float(upper_bounds[axis] if upper else lower_bounds[axis])
    point = extrema.PointOnShape1(1)
    return float((point.X(), point.Y(), point.Z())[axis])


def mesh_dimensional_error_mm(shape: TopoDS_Shape, vertices: np.ndarray) -> float:
    lower, upper = np.asarray(shape_bounds_mm(shape))
    cad_vertices = vertices[:, (0, 2, 1)] * np.array([1000, -1000, 1000])
    mesh_min = cad_vertices.min(axis=0)
    mesh_max = cad_vertices.max(axis=0)
    min_err = np.abs(mesh_min - lower)
    max_err = np.abs(mesh_max - upper)
    err_mm = float(max(np.max(min_err), np.max(max_err)))
    if err_mm <= 0.1:
        return err_mm
    trimmed_lower, trimmed_upper = np.asarray(trimmed_shape_bounds_mm(shape))
    min_err = np.abs(mesh_min - trimmed_lower)
    max_err = np.abs(mesh_max - trimmed_upper)
    err_mm = float(max(np.max(min_err), np.max(max_err)))
    if err_mm <= 0.1:
        return err_mm
    for axis in range(3):
        if min_err[axis] > 0.1:
            exact_min = _exact_axis_extent_mm(shape, axis, False, lower, upper)
            min_err[axis] = abs(float(mesh_min[axis]) - exact_min)
        if max_err[axis] > 0.1:
            exact_max = _exact_axis_extent_mm(shape, axis, True, lower, upper)
            max_err[axis] = abs(float(mesh_max[axis]) - exact_max)
    return float(max(np.max(min_err), np.max(max_err)))


def _mesh_geometry_from_visual(geometry: MeshGeometry | dict[str, Any]) -> MeshGeometry:
    if isinstance(geometry, MeshGeometry):
        return geometry
    vertices = np.asarray(geometry["vertices"], dtype=np.float32)
    normals = np.asarray(geometry["normals"], dtype=np.float32)
    indices = np.asarray(geometry["indices"], dtype=np.uint32)
    metric_uvs = geometry.get("metric_uvs")
    if metric_uvs is None:
        if len(vertices) == 0:
            metric_uvs = np.empty((0, 2), dtype=np.float32)
        else:
            chart_axes = np.argmax(np.abs(normals), axis=1)
            uv_columns = np.asarray(_UV_AXES)[chart_axes]
            metric_uvs = np.take_along_axis(vertices, uv_columns, axis=1).astype(
                np.float32, copy=False
            )
    return MeshGeometry(vertices, normals, indices, np.asarray(metric_uvs, dtype=np.float32))


def tessellate_step_geometry(
    shape: TopoDS_Shape, face_colors: list[tuple[TopoDS_Shape, str | None]], origin: str,
) -> MeshGeometry:
    styled_origin = origin in {"cots_library_step", "kicad_pcb_step", "procedural_harness"}
    distinct_colors = {color for _, color in face_colors if color is not None}
    if not distinct_colors or (not styled_origin and len(distinct_colors) < 2):
        mesh = MeshGeometry(*tessellate_shape_meters_y_up(shape))
        if len(mesh.vertices) and mesh_dimensional_error_mm(shape, mesh.vertices) > 0.1:
            BRepTools.Clean_s(shape)
            mesh = MeshGeometry(*tessellate_shape_meters_y_up(shape, linear_deflection=0.05, angular_deflection=0.22))
        return mesh

    builder = BRep_Builder()
    groups: dict[str | None, TopoDS_Compound] = {}
    for face, color in face_colors:
        if color not in groups:
            groups[color] = TopoDS_Compound()
            builder.MakeCompound(groups[color])
        builder.Add(groups[color], face)

    primitives: list[MeshPrimitiveGeometry] = []
    min_mesh_size_mm = _HARNESS_MIN_MESH_SIZE_MM if origin == "procedural_harness" else -1.0
    for color, group in groups.items():
        arrays = tessellate_shape_meters_y_up(
            group, linear_deflection=0.03, angular_deflection=0.15, min_mesh_size_mm=min_mesh_size_mm,
        )
        if len(arrays[2]):
            primitives.append(MeshPrimitiveGeometry(*arrays, color_hex=color))

    if not primitives:
        return MeshGeometry(*tessellate_shape_meters_y_up(shape))

    offset = 0
    indices: list[np.ndarray] = []
    for primitive in primitives:
        indices.append(primitive.indices + offset)
        offset += len(primitive.vertices)
    return MeshGeometry(
        np.concatenate([primitive.vertices for primitive in primitives]),
        np.concatenate([primitive.normals for primitive in primitives]),
        np.concatenate(indices),
        np.concatenate([primitive.metric_uvs for primitive in primitives]),
        tuple(primitives),
    )


def _mesh_materials(
    node: dict[str, Any], geometry: MeshGeometry
) -> list[tuple[str, MeshPrimitiveGeometry | MeshGeometry, list[float], MaterialSkinSpec]]:
    cid = node["id"]
    color_hex = node["colorHex"]
    material_hint = node["materialHint"]
    if not geometry.primitives:
        return [(cid, geometry, srgb_hex_to_linear_rgba(color_hex), resolve_material_skin(material_hint))]
    return [
        (
            f"{cid}_{index}",
            primitive,
            srgb_hex_to_linear_rgba(primitive.color_hex or color_hex),
            resolve_material_skin(primitive.material_hint or material_hint),
        )
        for index, primitive in enumerate(geometry.primitives)
    ]


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
    by_id = {node["id"]: node for node in nodes_spec}
    index_by_id = {node["id"]: index for index, node in enumerate(nodes_spec)}
    exported_leaf_ids: list[str] = []
    textures_by_family: dict[SkinFamily, tuple[int, int, int]] = {}

    children_by_id: dict[str, list[int]] = {n["id"]: [] for n in nodes_spec}
    for idx, node_spec in enumerate(nodes_spec):
        pid = node_spec["parentId"]
        if pid is not None and pid in children_by_id:
            children_by_id[pid].append(idx)

    for node_spec in nodes_spec:
        cid = node_spec["id"]
        pid = node_spec["parentId"]
        local_translation, quaternion, local_rotation = local_pose(node_spec, by_id.get(pid))

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
            primitives: list[Primitive] = []
            for material_id, geom, tint, skin in _mesh_materials(node_spec, geometry_by_id[cid]):
                if skin.family not in textures_by_family:
                    textures_by_family[skin.family] = _append_glb_skin_textures(gltf, binary_blob, skin.family)
                albedo, normal, metallic_roughness = textures_by_family[skin.family]

                mat_idx = len(gltf.materials)
                gltf.materials.append(
                    Material(
                        name=f"mat_{material_id}",
                        pbrMetallicRoughness=PbrMetallicRoughness(
                            baseColorFactor=tint,
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

                primitives.append(
                    Primitive(
                        attributes={"POSITION": pos_acc_idx, "NORMAL": norm_acc_idx, "TEXCOORD_0": uv_acc_idx},
                        indices=idx_acc_idx,
                        material=mat_idx,
                    )
                )

            mesh_index = len(gltf.meshes)
            gltf.meshes.append(Mesh(name=f"mesh_{cid}", primitives=primitives))
            exported_leaf_ids.append(cid)

        gltf.nodes.append(
            Node(
                name=cid,
                children=children_by_id[cid],
                translation=local_translation,
                rotation=[quaternion.X(), quaternion.Y(), quaternion.Z(), quaternion.W()]
                if local_rotation is not None else None,
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

    materials_by_component = {
        cid: _mesh_materials(by_id[cid], geom) for cid, geom in geometry_by_id.items()
    }
    materials = {
        material_id: (tint, skin)
        for bindings in materials_by_component.values()
        for material_id, _, tint, skin in bindings
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
        (dx, dy, dz), _, rotation = local_pose(node, by_id.get(pid))
        xform_order = '"xformOp:translate"'
        lines.extend([
            f'{pad}def Xform "{cid}"',
            f"{pad}{{",
            f"{pad}    double3 xformOp:translate = ({dx}, {dy}, {dz})",
        ])
        if rotation is not None:
            x, y, z = (round(angle, 9) for angle in rotation)
            lines.append(f"{pad}    double3 xformOp:rotateXYZ = ({x}, {y}, {z})")
            xform_order += ', "xformOp:rotateXYZ"'
        lines.extend([
            f'{pad}    uniform token[] xformOpOrder = [{xform_order}]',
            f'{pad}    custom string componentId = "{cid}"',
        ])

        if cid in geometry_by_id:
            bindings = materials_by_component[cid]
            rgba = bindings[0][2]
            pts_str = ", ".join(
                f"({x:.6f}, {y:.6f}, {z:.6f})"
                for _, source, _, _ in bindings for x, y, z in source.vertices
            )
            norms_str = ", ".join(
                f"({x:.5f}, {y:.5f}, {z:.5f})"
                for _, source, _, _ in bindings for x, y, z in source.normals
            )
            uv_str = ", ".join(
                f"({u:.6f}, {1.0 - v:.6f})"
                for _, source, _, skin in bindings for u, v in source.metric_uvs / skin.tile_size_meters
            )
            vertex_offset = 0
            face_count = 0
            indices: list[str] = []
            for _, source, _, _ in bindings:
                indices.extend(str(int(index) + vertex_offset) for index in source.indices)
                vertex_offset += len(source.vertices)
                face_count += len(source.indices) // 3
            face_counts = ", ".join(["3"] * face_count)
            face_indices = ", ".join(indices)
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
            ])
            if geometry_by_id[cid].primitives:
                lines.append(f'{pad}        uniform token subsetFamily:materialBind:familyType = "partition"')
                face_offset = 0
                for idx, (material_id, primitive, _, _) in enumerate(bindings):
                    face_end = face_offset + len(primitive.indices) // 3
                    subset_indices = ", ".join(map(str, range(face_offset, face_end)))
                    lines.extend([
                        f'{pad}        def GeomSubset "sub_{idx}" (',
                        f'{pad}            prepend apiSchemas = ["MaterialBindingAPI"]',
                        f"{pad}        )",
                        f"{pad}        {{",
                        f'{pad}            uniform token elementType = "face"',
                        f'{pad}            uniform token familyName = "materialBind"',
                        f"{pad}            int[] indices = [{subset_indices}]",
                        f"{pad}            rel material:binding = </World/Materials/mat_{material_id}>",
                        f"{pad}        }}",
                    ])
                    face_offset = face_end
            else:
                lines.append(f"{pad}        rel material:binding = </World/Materials/mat_{cid}>")
            lines.append(f"{pad}    }}")

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
            positions = [
                accessors[primitive["attributes"]["POSITION"]]
                for primitive in meshes[node["mesh"]]["primitives"]
            ]
            bounds_by_id[cid] = (
                [min(axis) for axis in zip(*(acc["min"] for acc in positions))],
                [max(axis) for axis in zip(*(acc["max"] for acc in positions))],
            )
    return node_ids, bounds_by_id


def parse_usdz_prim_paths(usdz_path: Path) -> str:
    with zipfile.ZipFile(usdz_path, mode="r") as zf:
        return zf.read("model.usda").decode("utf-8")


def run_cad_pipeline(
    archetype_spec: dict[str, Any],
    output_dir: Path,
    cache_dir: Path,
    inject_collision_test: bool = False,
    check_interference: bool = True,
    visual_geometry_by_id: dict[str, MeshGeometry | dict[str, Any]] | None = None,
    allow_partial_geometry: bool = False,
    *,
    asset_cache: CadAssetCache | None = None,
    xbf_cache_dir: Path | None = None,
    parameter_overrides: dict[str, float | int] | None = None,
    render_views_dir: Path | None = None,
) -> dict[str, Any]:
    started = perf_counter()
    archetype_id = archetype_spec["archetypeId"]
    if archetype_id == "parametric_multirotor_v1":
        from parametric_multirotor import materialize_multirotor

        archetype_spec = materialize_multirotor(archetype_spec, cache_dir, parameter_overrides)
    nodes_spec = list(archetype_spec["nodes"])
    failures: list[str] = []

    resolved_by_id: dict[str, dict[str, Any]] = {}
    placed_shapes: dict[str, Any] = {}
    placed_solids: dict[str, Any] = {}
    styled_steps: dict[str, tuple[Path, Any]] = {}
    geometry_by_id: dict[str, MeshGeometry] = {
        cid: _mesh_geometry_from_visual(geometry)
        for cid, geometry in (visual_geometry_by_id or {}).items()
    }
    max_dim_err_mm = 0.0
    brep_valid = True

    cache = asset_cache if asset_cache is not None else CadAssetCache(xbf_cache_dir or DEFAULT_XBF_DIR)
    modes: list[CacheMode] = []
    repair_attempts = 0
    relationships = archetype_spec.get("relationships", [])
    relationships_by_id = {relationship["id"]: relationship for relationship in relationships}
    routed_nodes = {
        node["id"] for node in nodes_spec
        if node["origin"] == "procedural_harness" and node.get("stepFixtureName") is not None
        and "relationshipId" in node.get("specifications", {})
    }
    collision_position = None
    collision_id = None
    if inject_collision_test:
        fixtures = [
            idx for idx, node in enumerate(nodes_spec)
            if node.get("stepFixtureName") is not None and node["id"] not in routed_nodes
        ]
        if len(fixtures) < 2:
            raise ValueError("Collision fault injection requires two physical components")
        collision_position = nodes_spec[fixtures[0]]["restPositionMeters"]
        collision_id = nodes_spec[fixtures[-1]]["id"]
    routing_spec = {**archetype_spec, "nodes": list(nodes_spec)}
    node_order = sorted(range(len(nodes_spec)), key=lambda idx: nodes_spec[idx]["id"] in routed_nodes)
    for idx in node_order:
        node_spec = nodes_spec[idx]
        cid = node_spec["id"]
        try:
            if cid in routed_nodes:
                relationship_id = node_spec["specifications"]["relationshipId"]
                relationship = relationships_by_id.get(relationship_id, {})
                max_repairs = (
                    0
                    if inject_collision_test
                    or relationship.get("routingWaypointsMeters")
                    or relationship.get("routingStyle") == "filleted_polyline"
                    else 2
                )
                for attempt in range(max_repairs + 1):
                    try:
                        resolved = route_harness_for_node(
                            node_spec, routing_spec, cache_dir, placed_solids, repair_attempt=attempt, harness_ids=routed_nodes,
                        )
                        break
                    except CableRoutingBlockedError:
                        if attempt == max_repairs:
                            raise
                        repair_attempts = max(repair_attempts, attempt + 1)
                node_spec = {
                    **node_spec,
                    "restPositionMeters": resolved["restPositionMeters"],
                    "dimensionsMm": resolved["dimensionsMm"],
                    "specifications": {
                        **node_spec["specifications"],
                        "brepFaces": resolved["faceCount"],
                    },
                }
                nodes_spec[idx] = node_spec
                asset, _ = cache.load(resolved["stepPath"], node_spec["origin"], resolved["sha256"])
                resolved["meshGeometry"] = asset.mesh_geometry
            else:
                resolved = resolve_component_step(node_spec, cache_dir, cache)
                if "cacheMode" in resolved and node_spec["origin"] != "parametric_cad":
                    modes.append(resolved["cacheMode"])
        except (InvalidBRepError, CableRoutingBlockedError) as error:
            brep_valid = brep_valid and not isinstance(error, InvalidBRepError)
            failures.append(f"{cid}: {error}")
            resolved_by_id[cid] = {
                "hasGeometry": False,
                "targetVerifiedStatus": GEOMETRY_ORIGIN_POLICY[node_spec["origin"]]["targetVerifiedStatus"],
            }
            continue
        resolved_by_id[cid] = resolved
        provenance_failure = resolved.get("provenanceFailure")
        if provenance_failure is not None:
            failures.append(provenance_failure)

        geometry_state = node_spec.get("geometry") or {}
        geometry_kind = geometry_state.get("kind")
        if geometry_kind in ("unavailable", "visual_only"):
            failures.append(
                f"Component {cid} has {geometry_kind} CAD geometry and cannot be verified"
            )
        elif node_spec["level"] in ("component", "subcomponent") and not resolved["hasGeometry"]:
            failures.append(f"Component {cid} is missing CAD geometry")

        if not resolved["hasGeometry"]:
            continue

        shape = resolved["shape"]
        if cid == collision_id:
            node_spec = {**node_spec, "restPositionMeters": collision_position}
            nodes_spec[idx] = node_spec
        placed_shape = place_shape(shape, node_spec)
        placed_shapes[cid] = placed_shape

        has_solid = TopExp_Explorer(shape, TopAbs_SOLID).More()
        has_free_surface = (
            TopExp_Explorer(shape, TopAbs_SHELL, TopAbs_SOLID).More()
            or TopExp_Explorer(shape, TopAbs_FACE, TopAbs_SOLID).More()
        )
        declared_role = geometry_state.get("role")
        if declared_role == "surface":
            if has_solid:
                failures.append(f"Component {cid} declared surface contains CAD solids")
                placed_solids[cid] = placed_shape
            else:
                failures.append(
                    f"Open surface component {cid} excluded from solid volumetric interference check"
                )
        elif not has_solid:
            failures.append(f"Component {cid} has no CAD solid for volumetric interference check")
        else:
            placed_solids[cid] = placed_shape
            if declared_role == "solid" and has_free_surface:
                failures.append(
                    f"Component {cid} declared solid contains open surface geometry outside CAD solids"
                )
        if node_spec["origin"] == "kicad_pcb_step" and cid in placed_solids:
            styled_steps[cid] = resolved["stepPath"], node_transform(node_spec)

        geometry = resolved["meshGeometry"]
        verts = geometry.vertices
        if len(verts) == 0 or len(geometry.indices) == 0:
            failures.append(f"Empty triangulation for {cid}")
        else:
            err_mm = mesh_dimensional_error_mm(shape, verts)
            max_dim_err_mm = max(max_dim_err_mm, err_mm)
            if err_mm > 0.1:
                failures.append(f"Dimensional tolerance exceeded for {cid}: {err_mm:.4f} mm > 0.1 mm")

            geometry_by_id[cid] = geometry
    if check_interference:
        bounds_by_id = {cid: shape_bounds_mm(shape) for cid, shape in placed_solids.items()}
        face_boxes_by_id = {cid: extract_face_boxes(shape) for cid, shape in placed_solids.items()}
        solid_probes_by_id = {cid: extract_solid_probes(shape) for cid, shape in placed_solids.items()}
        floating = floating_components(placed_solids, bounds_by_id, face_boxes=face_boxes_by_id)
        if floating:
            failures.append(f"Floating components: {', '.join(floating)}")
        electrical = electrical_failures(nodes_spec, relationships)
        failures.extend(electrical)
        solid_ids = [node["id"] for node in nodes_spec if node["id"] in placed_solids]
    else:
        floating = []
        electrical = []
        solid_ids = []
        bounds_by_id = {}
        face_boxes_by_id = {}
        solid_probes_by_id = {}
        failures.append("Volumetric interference analysis not performed for source inspection")
    interference_count = 0
    classifiers: dict[str, Any] = {}
    for i in range(len(solid_ids)):
        for j in range(i + 1, len(solid_ids)):
            id_a = solid_ids[i]
            id_b = solid_ids[j]
            bmin_a, bmax_a = bounds_by_id[id_a]
            bmin_b, bmax_b = bounds_by_id[id_b]
            if (
                bmin_a[0] >= bmax_b[0]
                or bmax_a[0] <= bmin_b[0]
                or bmin_a[1] >= bmax_b[1]
                or bmax_a[1] <= bmin_b[1]
                or bmin_a[2] >= bmax_b[2]
                or bmax_a[2] <= bmin_b[2]
            ):
                continue
            if not solids_may_intersect(
                id_a,
                id_b,
                placed_solids[id_a],
                placed_solids[id_b],
                face_boxes_by_id[id_a],
                face_boxes_by_id[id_b],
                bounds_by_id[id_a],
                bounds_by_id[id_b],
                solid_probes_by_id[id_a],
                solid_probes_by_id[id_b],
                classifiers,
            ):
                continue
            vol = interference_volume_mm3(placed_solids[id_a], placed_solids[id_b])
            if vol > INTERFERENCE_TOLERANCE_MM3:
                interference_count += 1
                failures.append(f"Volumetric interference between {id_a} and {id_b}: {vol:.4f} mm^3")

    output_dir.mkdir(parents=True, exist_ok=True)
    step_out = output_dir / "model.step"
    glb_out = output_dir / "model.glb"
    usdz_out = output_dir / "model.usdz"

    step_component_ids = [node["id"] for node in nodes_spec if node["id"] in placed_shapes]
    write_colored_step(
        step_out,
        [
            (cid, placed_shapes[cid], resolved_by_id[cid].get("conductorColors", ()))
            for cid in step_component_ids
        ],
        styled_steps=styled_steps,
    )

    all_checks_ok = brep_valid and interference_count == 0 and max_dim_err_mm <= 0.1 and len(failures) == 0
    target_status = (
        "composed_validated"
        if any(node["targetVerifiedStatus"] == "composed_validated" for node in resolved_by_id.values())
        else "sourced_verified"
    )
    project_status = target_status if all_checks_ok else "unverified"

    exported_glb_ids = export_hierarchical_glb(nodes_spec, geometry_by_id, project_status, glb_out)
    prim_paths = export_usdz_archive(nodes_spec, geometry_by_id, usdz_out)

    parsed_glb_ids, _ = parse_glb_diagnostics(glb_out)
    usda_text = parse_usdz_prim_paths(usdz_out)

    expected_leaf_ids = [
        n["id"]
        for n in nodes_spec
        if n["level"] in ("component", "subcomponent")
        and (not allow_partial_geometry or n.get("geometry", {}).get("kind") != "unavailable")
    ]
    expected = Counter(expected_leaf_ids)
    expected_step_ids = Counter(
        n["id"]
        for n in nodes_spec
        if n["level"] in ("component", "subcomponent")
        and (
            not allow_partial_geometry
            or n.get("geometry", {}).get("kind") not in ("unavailable", "visual_only")
        )
    )
    step_ids = re.findall(r"PRODUCT\('([^']+)'", step_out.read_text(encoding="ascii"))
    step_mapping_ok = Counter(cid for cid in step_ids if cid in expected_step_ids) == expected_step_ids
    glb_mapping_ok = Counter(parsed_glb_ids) == Counter(exported_glb_ids) == expected
    usdz_mapping_ok = Counter(re.findall(r'def Xform "([^"]+)"', usda_text)) == Counter(["World", *prim_paths])
    usdz_mesh_mapping_ok = Counter(
        cid for cid in re.findall(r'custom string componentId = "([^"]+)"', usda_text)
        if cid in expected
    ) == Counter({cid: count * 2 for cid, count in expected.items()})
    node_mapping_complete = step_mapping_ok and glb_mapping_ok and usdz_mapping_ok and usdz_mesh_mapping_ok
    if not node_mapping_complete:
        failures.append("Incomplete 1:1 componentId mapping across Firestore, STEP, GLB, and USDZ")
        if all_checks_ok:
            export_hierarchical_glb(nodes_spec, geometry_by_id, "unverified", glb_out)

    valid = all_checks_ok and node_mapping_complete
    final_status = target_status if valid else "unverified"

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
        resolved = resolved_by_id[cid]
        node_status = resolved["targetVerifiedStatus"] if valid else "unverified"
        node_sha = resolved.get("sha256", step_sha)

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
                **({"restRotationDeg": node_spec["restRotationDeg"]} if "restRotationDeg" in node_spec else {}),
                "explodeDirection": node_spec["explodeDirection"],
                "explodeDistanceMeters": node_spec["explodeDistanceMeters"],
                "materialHint": node_spec["materialHint"],
                "specifications": node_spec["specifications"],
                **({"ports": node_spec["ports"]} if "ports" in node_spec else {}),
                **({"mountingInterfaces": node_spec["mountingInterfaces"]}
                   if "mountingInterfaces" in node_spec else {}),
                **({"enclosureRole": node_spec["enclosureRole"]} if "enclosureRole" in node_spec else {}),
                **({"geometry": node_spec["geometry"]} if "geometry" in node_spec else {}),
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
                "publicUrl": f"/assemblies/{manifest_hash}/model.step",
                "sha256": step_sha,
                "sizeBytes": len(step_bytes),
            },
            "glb": {
                "format": "glb",
                "storagePath": f"assemblies/{manifest_hash}/model.glb",
                "publicUrl": f"/assemblies/{manifest_hash}/model.glb",
                "sha256": glb_sha,
                "sizeBytes": len(glb_bytes),
            },
            "usdz": {
                "format": "usdz",
                "storagePath": f"assemblies/{manifest_hash}/model.usdz",
                "publicUrl": f"/assemblies/{manifest_hash}/model.usdz",
                "sha256": usdz_sha,
                "sizeBytes": len(usdz_bytes),
            },
        },
    }

    visual_paths = []
    if render_views_dir is not None:
        from visual_renderer import render_contact_sheet

        visual_paths.append(str(render_contact_sheet(
            nodes_spec, geometry_by_id, render_views_dir / f"{archetype_id}.png",
        )))

    validation = {
        "valid": valid,
        "brepValid": brep_valid,
        "interferenceCount": interference_count,
        "maxDimensionalErrorMm": round(max_dim_err_mm, 5),
        "nodeMappingComplete": node_mapping_complete,
        "unitSystem": "meters_y_up",
        "checkedAtIso": now_iso,
        "failures": failures,
        "connectivityValid": not floating,
        "floatingComponentIds": floating,
        "electricalValid": not electrical,
        "electricalFailures": electrical,
        "repairAttempts": repair_attempts,
        "visualRenderPaths": visual_paths,
        "buildTimingMs": {"totalMs": round((perf_counter() - started) * 1000, 3), "cacheMode": build_cache_mode(modes)},
    }

    result = {
        "archetypeId": archetype_id,
        "verificationStatus": final_status,
        "nodes": enriched_nodes,
        "relationships": relationships,
        "assemblySteps": archetype_spec.get("assemblySteps", []),
        **{field: archetype_spec[field] for field in ("parameters", "parameterValues") if field in archetype_spec},
        "manifest": manifest,
        "validation": validation,
        "glbNodeIds": parsed_glb_ids,
        "usdzPrimPaths": [prim_paths[cid] for cid in expected_leaf_ids],
    }

    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (output_dir / "pipeline_result.json").write_text(json.dumps(result, indent=2))
    return result
