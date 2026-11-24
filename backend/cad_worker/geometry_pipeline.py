from __future__ import annotations

import datetime
import hashlib
import json
import struct
import zipfile
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
    Material,
    Mesh,
    Node,
    PbrMetallicRoughness,
    Primitive,
    Scene,
)

from catalog_ingestor import MIN_CAD_BREP_FACES, resolve_component_step


MATERIAL_PBR_TABLE: dict[str, tuple[float, float]] = {
    "carbon_fiber": (0.15, 0.38),
    "carbon_fiber_composite": (0.15, 0.38),
    "anodized_aluminum": (0.86, 0.28),
    "machined_aluminum": (0.88, 0.24),
    "extruded_aluminum": (0.86, 0.28),
    "anodized_steel": (0.90, 0.26),
    "stainless_steel": (0.92, 0.22),
    "brass": (0.92, 0.22),
    "copper_winding": (0.92, 0.28),
    "polycarbonate": (0.05, 0.25),
    "fr4_pcb": (0.08, 0.48),
    "abs_3d_printed": (0.06, 0.52),
    "pla_3d_printed": (0.06, 0.50),
    "acetal_polymer": (0.05, 0.45),
    "nylon_glass_filled": (0.05, 0.55),
    "servo_housing": (0.10, 0.42),
    "optical_glass": (0.12, 0.08),
}


def material_pbr_factors(material_hint: str) -> tuple[float, float]:
    return MATERIAL_PBR_TABLE.get(material_hint, (0.25, 0.45))


def hex_to_rgba(hex_color: str) -> list[float]:
    clean = hex_color.lstrip("#")
    r = int(clean[0:2], 16) / 255.0
    g = int(clean[2:4], 16) / 255.0
    b = int(clean[4:6], 16) / 255.0
    return [round(r, 4), round(g, 4), round(b, 4), 1.0]


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


def tessellate_shape_meters_y_up(
    shape,
    linear_deflection: float = 0.2,
    angular_deflection: float = 0.4,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    BRepMesh_IncrementalMesh(shape, linear_deflection, False, angular_deflection, True)
    vertices: list[list[float]] = []
    normals: list[list[float]] = []
    indices: list[int] = []
    vertex_offset = 0

    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face(explorer.Current())
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is not None:
            trsf = loc.Transformation()
            nb_nodes = tri.NbNodes()
            face_verts: list[np.ndarray] = []
            for idx in range(1, nb_nodes + 1):
                pnt = tri.Node(idx).Transformed(trsf)
                pos = np.array([pnt.X() / 1000.0, pnt.Z() / 1000.0, -pnt.Y() / 1000.0], dtype=np.float32)
                face_verts.append(pos)
                vertices.append(pos.tolist())
                normals.append([0.0, 0.0, 0.0])

            is_reversed = face.Orientation() == 1
            nb_tris = tri.NbTriangles()
            for idx in range(1, nb_tris + 1):
                triangle = tri.Triangle(idx)
                n1, n2, n3 = triangle.Get()
                i1, i2, i3 = (n1 - 1, n3 - 1, n2 - 1) if is_reversed else (n1 - 1, n2 - 1, n3 - 1)
                v1, v2, v3 = face_verts[i1], face_verts[i2], face_verts[i3]
                edge1 = v2 - v1
                edge2 = v3 - v1
                fn = np.cross(edge1, edge2)
                fn_len = float(np.linalg.norm(fn))
                if fn_len > 1e-12:
                    fn = fn / fn_len
                for local_idx in (i1, i2, i3):
                    g_idx = vertex_offset + local_idx
                    normals[g_idx][0] += float(fn[0])
                    normals[g_idx][1] += float(fn[1])
                    normals[g_idx][2] += float(fn[2])
                indices.extend([vertex_offset + i1, vertex_offset + i2, vertex_offset + i3])
            vertex_offset += nb_nodes
        explorer.Next()

    v_arr = np.array(vertices, dtype=np.float32)
    n_arr = np.array(normals, dtype=np.float32)
    norms = np.linalg.norm(n_arr, axis=1, keepdims=True)
    norms[norms < 1e-12] = 1.0
    n_arr = (n_arr / norms).astype(np.float32)
    i_arr = np.array(indices, dtype=np.uint32)
    return v_arr, n_arr, i_arr


def _pad4(data: bytes, pad_byte: bytes = b"\x00") -> bytes:
    rem = len(data) % 4
    if rem == 0:
        return data
    return data + pad_byte * (4 - rem)


def export_hierarchical_glb(
    nodes_spec: list[dict[str, Any]],
    geometry_by_id: dict[str, dict[str, Any]],
    verification_status: str,
    out_path: Path,
) -> list[str]:
    gltf = GLTF2(scene=0, scenes=[Scene(nodes=[0])], nodes=[], meshes=[], materials=[], accessors=[], bufferViews=[], buffers=[])
    binary_blob = bytearray()
    index_by_id: dict[str, int] = {}
    rest_by_id: dict[str, list[float]] = {}
    exported_leaf_ids: list[str] = []

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
            verts: np.ndarray = geom["vertices"]
            norms: np.ndarray = geom["normals"]
            idxs: np.ndarray = geom["indices"]
            metallic, roughness = material_pbr_factors(str(node_spec.get("materialHint", "")))

            mat_idx = len(gltf.materials)
            gltf.materials.append(
                Material(
                    name=f"mat_{cid}",
                    pbrMetallicRoughness=PbrMetallicRoughness(
                        baseColorFactor=hex_to_rgba(node_spec["colorHex"]),
                        metallicFactor=metallic,
                        roughnessFactor=roughness,
                    ),
                )
            )

            pos_bytes = _pad4(verts.tobytes())
            pos_offset = len(binary_blob)
            binary_blob.extend(pos_bytes)
            pos_bv_idx = len(gltf.bufferViews)
            gltf.bufferViews.append(
                BufferView(buffer=0, byteOffset=pos_offset, byteLength=len(verts.tobytes()), target=ARRAY_BUFFER)
            )
            pos_acc_idx = len(gltf.accessors)
            gltf.accessors.append(
                Accessor(
                    bufferView=pos_bv_idx,
                    componentType=FLOAT,
                    count=len(verts),
                    type="VEC3",
                    min=[float(v) for v in verts.min(axis=0)],
                    max=[float(v) for v in verts.max(axis=0)],
                )
            )

            norm_bytes = _pad4(norms.tobytes())
            norm_offset = len(binary_blob)
            binary_blob.extend(norm_bytes)
            norm_bv_idx = len(gltf.bufferViews)
            gltf.bufferViews.append(
                BufferView(buffer=0, byteOffset=norm_offset, byteLength=len(norms.tobytes()), target=ARRAY_BUFFER)
            )
            norm_acc_idx = len(gltf.accessors)
            gltf.accessors.append(
                Accessor(bufferView=norm_bv_idx, componentType=FLOAT, count=len(norms), type="VEC3")
            )

            idx_bytes = _pad4(idxs.tobytes())
            idx_offset = len(binary_blob)
            binary_blob.extend(idx_bytes)
            idx_bv_idx = len(gltf.bufferViews)
            gltf.bufferViews.append(
                BufferView(
                    buffer=0,
                    byteOffset=idx_offset,
                    byteLength=len(idxs.tobytes()),
                    target=ELEMENT_ARRAY_BUFFER,
                )
            )
            idx_acc_idx = len(gltf.accessors)
            gltf.accessors.append(
                Accessor(bufferView=idx_bv_idx, componentType=UNSIGNED_INT, count=len(idxs), type="SCALAR")
            )

            mesh_index = len(gltf.meshes)
            gltf.meshes.append(
                Mesh(
                    name=f"mesh_{cid}",
                    primitives=[
                        Primitive(
                            attributes={"POSITION": pos_acc_idx, "NORMAL": norm_acc_idx},
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


def export_usdz_archive(
    nodes_spec: list[dict[str, Any]],
    geometry_by_id: dict[str, dict[str, Any]],
    out_path: Path,
) -> dict[str, str]:
    by_id = {n["id"]: n for n in nodes_spec}
    children_map: dict[str | None, list[dict[str, Any]]] = {}
    for n in nodes_spec:
        children_map.setdefault(n["parentId"], []).append(n)

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
    ]

    def emit_node(node: dict[str, Any], indent: int) -> None:
        pad = " " * indent
        cid = node["id"]
        pid = node["parentId"]
        rest = node["restPositionMeters"]
        p_rest = by_id[pid]["restPositionMeters"] if pid is not None and pid in by_id else [0.0, 0.0, 0.0]
        dx = round(rest[0] - p_rest[0], 6)
        dy = round(rest[1] - p_rest[1], 6)
        dz = round(rest[2] - p_rest[2], 6)

        if cid in geometry_by_id:
            geom = geometry_by_id[cid]
            verts: np.ndarray = geom["vertices"]
            norms: np.ndarray = geom["normals"]
            idxs: np.ndarray = geom["indices"]
            pts_str = ", ".join(f"({v[0]:.6f}, {v[1]:.6f}, {v[2]:.6f})" for v in verts)
            norms_str = ", ".join(f"({n[0]:.5f}, {n[1]:.5f}, {n[2]:.5f})" for n in norms)
            face_counts = ", ".join(["3"] * (len(idxs) // 3))
            face_indices = ", ".join(str(int(i)) for i in idxs)
            rgba = hex_to_rgba(node["colorHex"])
            lines.append(f'{pad}def Xform "{cid}"')
            lines.append(f"{pad}{{")
            lines.append(f"{pad}    double3 xformOp:translate = ({dx}, {dy}, {dz})")
            lines.append(f'{pad}    uniform token[] xformOpOrder = ["xformOp:translate"]')
            lines.append(f'{pad}    custom string componentId = "{cid}"')
            lines.append(f'{pad}    def Mesh "Mesh"')
            lines.append(f"{pad}    {{")
            lines.append(f"{pad}        int[] faceVertexCounts = [{face_counts}]")
            lines.append(f"{pad}        int[] faceVertexIndices = [{face_indices}]")
            lines.append(f"{pad}        point3f[] points = [{pts_str}]")
            lines.append(f"{pad}        normal3f[] normals = [{norms_str}]")
            lines.append(f"{pad}        color3f[] primvars:displayColor = [({rgba[0]}, {rgba[1]}, {rgba[2]})]")
            lines.append(f"{pad}    }}")
        else:
            lines.append(f'{pad}def Xform "{cid}"')
            lines.append(f"{pad}{{")
            lines.append(f"{pad}    double3 xformOp:translate = ({dx}, {dy}, {dz})")
            lines.append(f'{pad}    uniform token[] xformOpOrder = ["xformOp:translate"]')
            lines.append(f'{pad}    custom string componentId = "{cid}"')

        for child in children_map.get(cid, []):
            emit_node(child, indent + 4)

        lines.append(f"{pad}}}")

    for root in children_map.get(None, []):
        emit_node(root, 4)

    lines.append("}")
    usda_bytes = ("\n".join(lines) + "\n").encode("utf-8")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, mode="w", compression=zipfile.ZIP_STORED) as zf:
        zf.writestr("model.usda", usda_bytes)

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
    check_interference: bool = True,
) -> dict[str, Any]:
    archetype_id = archetype_spec["archetypeId"]
    nodes_spec = list(archetype_spec["nodes"])
    failures: list[str] = []

    ingested: dict[str, dict[str, Any]] = {}
    placed_solids: dict[str, Any] = {}
    geometry_by_id: dict[str, dict[str, Any]] = {}
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
        if node_spec.get("geometry", {}).get("role") != "surface":
            placed_solids[cid] = placed_shape
        builder.Add(compound, placed_shape)

        verts, norms, idxs = tessellate_shape_meters_y_up(shape)
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

        geometry_by_id[cid] = {
            "vertices": verts,
            "normals": norms,
            "indices": idxs,
        }
        ingested[cid] = resolved

    interference_count = 0
    solid_ids = list(placed_solids.keys()) if check_interference else []
    if not check_interference:
        failures.append("Volumetric interference analysis not performed for source inspection")
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

    expected_leaf_ids = [n["id"] for n in nodes_spec if n["level"] in ("component", "subcomponent") and n.get("geometry", {}).get("kind") != "unavailable"]
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
