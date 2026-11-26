from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any
from xml.etree import ElementTree

from ingest_upstream_catalog import center_and_write_step, exact_bounds_mm
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_SOLID
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer


REPO_ROOT = Path(__file__).resolve().parents[2]
ARCHETYPE_ID = "dual_scorpion_v1"
SOURCE_COMMIT = "cc5b46ca9611ea5568b017bc5bff9f01945d25a3"
SOURCE_REPOSITORY = "https://github.com/momoiorg-repository/dual_scorpion"
SOURCE_ROOT = f"dual_scorpion-{SOURCE_COMMIT}"
SOURCE_RAW_BASE = f"https://raw.githubusercontent.com/momoiorg-repository/dual_scorpion/{SOURCE_COMMIT}"
SOURCE_ARCHIVE_URL = f"https://github.com/momoiorg-repository/dual_scorpion/archive/{SOURCE_COMMIT}.zip"
SOURCE_URDF_PATH = "dual_scorpion_Full_urdf/urdf/scorpion.urdf"
SOURCE_URDF_URL = f"{SOURCE_RAW_BASE}/{SOURCE_URDF_PATH}"
SOURCE_LICENSE = "Apache-2.0"
SOURCE_NAME = f"Momoi Open Source Organization, Dual Scorpion at {SOURCE_COMMIT}"
CATALOG_PATH = REPO_ROOT / "src" / "shared" / "domain" / "data" / "dual_scorpion_v1.json"
SOURCE_PART_PATTERN = re.compile(r"(.+)_\d+")
SOURCE_COMPONENT_PATTERN = re.compile(r"^[A-Za-z0-9_]+$")
ROOT_ID = "dual_scorpion_assembly"
ARM_IDS = {"r": "dual_scorpion_right_arm", "l": "dual_scorpion_left_arm"}
COLOR = "#aeb9c6"
MAX_URDF_ALIGNMENT_ERROR_MM = 1.0


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _read_archive(archive_path: Path) -> tuple[zipfile.ZipFile, str]:
    archive = zipfile.ZipFile(archive_path)
    roots: set[str] = set()
    for info in archive.infolist():
        path = PurePosixPath(info.filename)
        if path.is_absolute() or ".." in path.parts:
            archive.close()
            raise ValueError(f"Unsafe source archive path: {info.filename}")
        roots.add(path.parts[0])
    if roots != {SOURCE_ROOT}:
        archive.close()
        raise ValueError(f"Expected source archive root {SOURCE_ROOT}, found {sorted(roots)}")
    return archive, f"{SOURCE_ROOT}/"


def _read_urdf(archive: zipfile.ZipFile, prefix: str) -> tuple[ElementTree.Element, bytes]:
    try:
        payload = archive.read(f"{prefix}{SOURCE_URDF_PATH}")
    except KeyError as error:
        raise ValueError(f"Source archive is missing {SOURCE_URDF_PATH}") from error
    root = ElementTree.fromstring(payload)
    if root.tag != "robot" or root.get("name") != "scorpion":
        raise ValueError("Dual Scorpion source URDF has an unexpected robot root")
    return root, payload


def _collision_parts(urdf: ElementTree.Element) -> dict[str, tuple[str, tuple[str, ...]]]:
    result: dict[str, tuple[str, list[str]]] = {}
    for link in urdf.findall("link"):
        link_name = link.get("name")
        if not link_name:
            raise ValueError("Source URDF link is missing its name")
        for mesh in link.findall("./collision/geometry/mesh"):
            filename = mesh.get("filename")
            if not filename:
                continue
            part_match = SOURCE_PART_PATTERN.fullmatch(PurePosixPath(filename).stem)
            if part_match is None:
                continue
            part_name = part_match.group(1).casefold()
            previous = result.get(part_name)
            if previous is not None and previous[0] != link_name:
                raise ValueError(f"Source collision mesh maps {part_name} to multiple URDF links")
            if previous is None:
                result[part_name] = (link_name, [])
            result[part_name][1].append(filename)
    return {part_name: (link_name, tuple(mesh_paths)) for part_name, (link_name, mesh_paths) in result.items()}


def _joint_origins(urdf: ElementTree.Element) -> dict[str, tuple[str, tuple[float, float, float]]]:
    origins: dict[str, tuple[str, tuple[float, float, float]]] = {}
    for joint in urdf.findall("joint"):
        parent = joint.find("parent")
        child = joint.find("child")
        if parent is None or child is None:
            raise ValueError("Source URDF joint is missing its parent or child link")
        parent_name = parent.get("link")
        child_name = child.get("link")
        if not parent_name or not child_name:
            raise ValueError("Source URDF joint has an empty parent or child link")
        origin = joint.find("origin")
        xyz = tuple(float(value) for value in (origin.get("xyz", "0 0 0").split() if origin is not None else ("0", "0", "0")))
        rpy = tuple(float(value) for value in (origin.get("rpy", "0 0 0").split() if origin is not None else ("0", "0", "0")))
        if len(xyz) != 3 or len(rpy) != 3 or any(abs(value) > 1e-8 for value in rpy):
            raise ValueError("Source URDF joint transforms require unsupported rotation or coordinates")
        origins[child_name] = (parent_name, xyz)
    return origins


def _link_world_positions(urdf: ElementTree.Element) -> dict[str, tuple[float, float, float]]:
    origins = _joint_origins(urdf)
    positions: dict[str, tuple[float, float, float]] = {}

    def resolve(link_name: str, active: frozenset[str] = frozenset()) -> tuple[float, float, float]:
        if link_name in positions:
            return positions[link_name]
        if link_name in active:
            raise ValueError("Source URDF contains a cycle in its joint hierarchy")
        if link_name not in origins:
            position = (0.0, 0.0, 0.0)
        else:
            parent_name, offset = origins[link_name]
            parent_position = resolve(parent_name, active | {link_name})
            position = tuple(parent_position[axis] + offset[axis] for axis in range(3))
        positions[link_name] = position
        return position

    for link in urdf.findall("link"):
        link_name = link.get("name")
        if link_name:
            resolve(link_name)
    return positions


def _bounds_in_app_frame(rest_position: list[float], dimensions: list[float]) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    return (
        tuple(rest_position[axis] * 1000.0 - dimensions[axis] / 2 for axis in range(3)),
        tuple(rest_position[axis] * 1000.0 + dimensions[axis] / 2 for axis in range(3)),
    )


def _collision_bounds_mm(
    archive: zipfile.ZipFile,
    prefix: str,
    mesh_paths: tuple[str, ...],
    link_position_meters: tuple[float, float, float],
) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    minimum = [math.inf, math.inf, math.inf]
    maximum = [-math.inf, -math.inf, -math.inf]
    for mesh_path in mesh_paths:
        obj_path = f"{prefix}dual_scorpion_Full_urdf/urdf/{mesh_path}"
        try:
            payload = archive.read(obj_path)
        except KeyError as error:
            raise ValueError(f"Source URDF collision mesh is missing: {mesh_path}") from error
        for line in payload.decode("utf-8", errors="strict").splitlines():
            if not line.startswith("v "):
                continue
            coordinates = line.split()
            if len(coordinates) != 4:
                raise ValueError(f"Malformed source URDF collision vertex in {mesh_path}")
            for axis, coordinate in enumerate(coordinates[1:]):
                world_mm = float(coordinate) * 1000.0 + link_position_meters[axis] * 1000.0
                minimum[axis] = min(minimum[axis], world_mm)
                maximum[axis] = max(maximum[axis], world_mm)
    if any(math.isinf(value) for value in minimum + maximum):
        raise ValueError(f"Source URDF collision mesh has no vertices: {mesh_paths}")
    return tuple(minimum), tuple(maximum)


def _source_frame_alignment_error(
    archive: zipfile.ZipFile,
    prefix: str,
    source_shape: Any,
    source_stem: str,
    collision_parts: dict[str, tuple[str, tuple[str, ...]]],
    link_positions: dict[str, tuple[float, float, float]],
) -> float:
    link_name, mesh_paths = collision_parts[source_stem.casefold()]
    source_bounds = exact_bounds_mm(source_shape)
    collision_bounds = _collision_bounds_mm(archive, prefix, mesh_paths, link_positions[link_name])
    error = max(
        abs(source_bounds[bound][axis] - collision_bounds[bound][axis])
        for bound in range(2)
        for axis in range(3)
    )
    if error > MAX_URDF_ALIGNMENT_ERROR_MM:
        raise ValueError(
            f"Source STEP and URDF collision mesh frames differ for {source_stem}: "
            f"{error:.3f} mm > {MAX_URDF_ALIGNMENT_ERROR_MM:.3f} mm"
        )
    return error


def _union_bounds(
    bounds: list[tuple[tuple[float, float, float], tuple[float, float, float]]],
) -> tuple[list[float], list[float]]:
    minimum = [min(pair[0][axis] for pair in bounds) for axis in range(3)]
    maximum = [max(pair[1][axis] for pair in bounds) for axis in range(3)]
    return minimum, maximum


def _group_node(
    *,
    node_id: str,
    parent_id: str | None,
    name: str,
    level: str,
    depth: int,
    category: str,
    source_path: str,
    source_sha256: str,
) -> dict[str, Any]:
    return {
        "id": node_id,
        "parentId": parent_id,
        "name": name,
        "level": level,
        "depth": depth,
        "category": category,
        "colorHex": COLOR,
        "dimensionsMm": [0.0, 0.0, 0.0],
        "restPositionMeters": [0.0, 0.0, 0.0],
        "explodeDirection": [0.0, 0.0, 0.0],
        "explodeDistanceMeters": 0.0,
        "materialHint": "unspecified",
        "origin": "open_step_catalog",
        "spdxLicense": SOURCE_LICENSE,
        "sourceUrl": f"{SOURCE_RAW_BASE}/{source_path}",
        "sourceName": SOURCE_NAME,
        "stepFixtureName": None,
        "geometry": {"kind": "assembly"},
        "specifications": {
            "sourceSha256": source_sha256,
            "sourceOccurrencePath": source_path,
            "engineeringValidation": "Not established by source import",
            "geometryStatus": "assembly",
            "sourceCoordinateFrame": "urdf_z_up_meters",
        },
    }


def _read_source_shape(source_bytes: bytes, source_name: str) -> tuple[Any, str, int, bool]:
    with tempfile.NamedTemporaryFile(suffix=Path(source_name).suffix) as temporary:
        temporary.write(source_bytes)
        temporary.flush()
        reader = STEPControl_Reader()
        if reader.ReadFile(temporary.name) != IFSelect_RetDone:
            raise RuntimeError(f"Cannot read source STEP file {source_name}")
        reader.TransferRoots()
        shape = reader.OneShape()
    face_count = 0
    faces = TopExp_Explorer(shape, TopAbs_FACE)
    while faces.More():
        face_count += 1
        faces.Next()
    return shape, _sha256(source_bytes), face_count, BRepCheck_Analyzer(shape).IsValid()


def _geometry_role(shape: Any) -> str:
    solids = TopExp_Explorer(shape, TopAbs_SOLID)
    return "solid" if solids.More() else "surface"


def _build_catalog_from_archive(
    archive_path: Path,
    cache_dir: Path,
) -> tuple[dict[str, Any], dict[str, str]]:
    archive, prefix = _read_archive(archive_path)
    try:
        urdf, urdf_bytes = _read_urdf(archive, prefix)
        link_names = {link.get("name") for link in urdf.findall("link") if link.get("name")}
        link_positions = _link_world_positions(urdf)
        collision_parts = _collision_parts(urdf)
        part_links = {name: record[0] for name, record in collision_parts.items()}
        step_members = sorted(
            member
            for member in archive.namelist()
            if member.startswith(f"{prefix}STEP/follower/") and member.lower().endswith(".step")
        )
        if len(step_members) != 70:
            raise ValueError(f"Expected 70 follower STEP sources, found {len(step_members)}")
        source_stems = {Path(member).stem for member in step_members}
        if len(source_stems) != len(step_members):
            raise ValueError("Source STEP file names are not unique")
        missing_links = sorted(stem for stem in source_stems if stem.casefold() not in part_links)
        if missing_links:
            raise ValueError(f"Source STEP parts are not represented by URDF collision meshes: {missing_links}")
        if {stem.casefold() for stem in source_stems} != set(collision_parts):
            raise ValueError("Source URDF collision part set differs from the STEP source set")
        maximum_alignment_error = 0.0
        license_bytes = archive.read(f"{prefix}LICENSE")
        if b"Apache License" not in license_bytes or b"Version 2.0" not in license_bytes:
            raise ValueError("Source archive does not contain the expected Apache-2.0 license")

        root_node = _group_node(
            node_id=ROOT_ID,
            parent_id=None,
            name="Dual Scorpion",
            level="project",
            depth=0,
            category="assembly",
            source_path=SOURCE_URDF_PATH,
            source_sha256=_sha256(urdf_bytes),
        )
        nodes = [root_node]
        urdf_groups: dict[str, dict[str, Any]] = {}
        for group_id, name, source_path, category, depth in (
            (ARM_IDS["r"], "Right arm", SOURCE_URDF_PATH, "robot_subsystem", 1),
            (ARM_IDS["l"], "Left arm", SOURCE_URDF_PATH, "robot_subsystem", 1),
        ):
            group = _group_node(
                node_id=group_id,
                parent_id=ROOT_ID,
                name=name,
                level="subsystem",
                depth=depth,
                category=category,
                source_path=source_path,
                source_sha256=_sha256(urdf_bytes),
            )
            nodes.append(group)
            urdf_groups[group_id] = group

        link_group_ids: dict[str, str] = {}
        for link_name in sorted(link_names):
            if link_name == "base_link":
                parent_id = ROOT_ID
            elif link_name.startswith("r_link_"):
                parent_id = ARM_IDS["r"]
            elif link_name.startswith("l_link_"):
                parent_id = ARM_IDS["l"]
            else:
                continue
            group_id = f"dual_scorpion_{link_name}"
            link_group_ids[link_name] = group_id
            group = _group_node(
                node_id=group_id,
                parent_id=parent_id,
                name=link_name.replace("_", " ").title(),
                level="subsystem",
                depth=2,
                category="robot_link",
                source_path=SOURCE_URDF_PATH,
                source_sha256=_sha256(urdf_bytes),
            )
            nodes.append(group)
            urdf_groups[group_id] = group

        component_bounds: dict[str, tuple[tuple[float, float, float], tuple[float, float, float]]] = {}
        fixture_hashes: dict[str, str] = {}
        expected_source_paths: set[str] = set()
        cache_dir.mkdir(parents=True, exist_ok=True)
        for member in step_members:
            source_path = member[len(prefix):]
            source_name = PurePosixPath(source_path).name
            source_stem = Path(source_name).stem
            if not SOURCE_COMPONENT_PATTERN.fullmatch(source_stem):
                raise ValueError(f"Unsupported source STEP part name: {source_name}")
            link_name = part_links[source_stem.casefold()]
            if link_name not in link_group_ids:
                raise ValueError(f"Source STEP part maps to unsupported URDF link: {link_name}")
            source_bytes = archive.read(member)
            shape, source_sha256, face_count, brep_valid = _read_source_shape(source_bytes, source_name)
            alignment_error = _source_frame_alignment_error(
                archive,
                prefix,
                shape,
                source_stem,
                collision_parts,
                link_positions,
            )
            maximum_alignment_error = max(maximum_alignment_error, alignment_error)
            raw_bounds_min, raw_bounds_max = exact_bounds_mm(shape)
            fixture_name = f"dual_scorpion_{source_stem.casefold()}.step" if brep_valid and face_count >= 4 else None
            if fixture_name is not None:
                metadata = center_and_write_step(shape, cache_dir / fixture_name)
                fixture_hashes[fixture_name] = metadata["stepSha256"]
                dimensions_mm = [metadata["dimensionsMm"][0], metadata["dimensionsMm"][2], metadata["dimensionsMm"][1]]
                rest_position = metadata["restPositionMeters"]
                geometry = {"kind": "available", "role": _geometry_role(shape)}
                geometry_detail = geometry["role"]
            else:
                center = [(raw_bounds_min[axis] + raw_bounds_max[axis]) / 2 for axis in range(3)]
                raw_dimensions = [raw_bounds_max[axis] - raw_bounds_min[axis] for axis in range(3)]
                dimensions_mm = [raw_dimensions[0], raw_dimensions[2], raw_dimensions[1]]
                rest_position = [center[0] / 1000, center[2] / 1000, -center[1] / 1000]
                reason = "Source STEP BRep topology validation failed" if not brep_valid else "Source STEP has insufficient geometric detail"
                geometry = {"kind": "unavailable", "reason": reason}
                geometry_detail = reason
            node_id = f"dual_scorpion_part_{source_stem.casefold()}"
            node = {
                "id": node_id,
                "parentId": link_group_ids[link_name],
                "name": source_stem.replace("_", " ").title(),
                "level": "component",
                "depth": 3,
                "category": "cad_part",
                "colorHex": COLOR,
                "dimensionsMm": dimensions_mm,
                "restPositionMeters": rest_position,
                "explodeDirection": [0.0, 0.0, 0.0],
                "explodeDistanceMeters": 0.0,
                "materialHint": "unspecified",
                "origin": "open_step_catalog",
                "spdxLicense": SOURCE_LICENSE,
                "sourceUrl": f"{SOURCE_RAW_BASE}/{source_path}",
                "sourceName": SOURCE_NAME,
                "stepFixtureName": fixture_name,
                "geometry": geometry,
                "specifications": {
                    "sourceSha256": source_sha256,
                    "sourceOccurrencePath": source_path,
                    "urdfLinkName": link_name,
                    "sourceCoordinateFrame": "step_z_up_global_millimeters",
                    "applicationCoordinateFrame": "y_up_meters",
                    "engineeringValidation": "Not established by source import",
                    "brepFaces": face_count,
                    "geometryStatus": geometry["kind"],
                    "geometryDetail": geometry_detail,
                },
            }
            nodes.append(node)
            component_bounds[node_id] = _bounds_in_app_frame(rest_position, dimensions_mm)
            expected_source_paths.add(source_path)

        if len(expected_source_paths) != 70:
            raise ValueError(f"Expected 70 unique STEP source paths, found {len(expected_source_paths)}")

        child_groups: dict[str, list[str]] = {}
        for node in nodes:
            parent_id = node["parentId"]
            if parent_id is not None:
                child_groups.setdefault(parent_id, []).append(node["id"])
        bounds_by_id = dict(component_bounds)
        for node in reversed(nodes):
            child_bounds = [bounds_by_id[child_id] for child_id in child_groups.get(node["id"], []) if child_id in bounds_by_id]
            if child_bounds:
                minimum, maximum = _union_bounds(child_bounds)
                node["dimensionsMm"] = [round(maximum[axis] - minimum[axis], 2) for axis in range(3)]
                if node["level"] != "component":
                    bounds_by_id[node["id"]] = (tuple(minimum), tuple(maximum))

        _assign_inspection_offsets(nodes)
        catalog = {
            "semantics": "source_inspection",
            "archetypeId": ARCHETYPE_ID,
            "title": "Dual Scorpion source CAD inspection",
            "summary": "Pinned Dual Scorpion follower STEP parts organized by URDF link. Geometry is imported from source CAD; engineering validation and assembly instructions are not established.",
            "keywords": ["dual scorpion", "dual_scorpion", "bimanual robot", "bimanual", "dual arm", "scorpion"],
            "rootNodeId": ROOT_ID,
            "nodes": nodes,
            "relationships": [],
            "assemblySteps": [],
            "sourceCommit": SOURCE_COMMIT,
            "sourceRepository": SOURCE_REPOSITORY,
            "sourceArchiveSha256": _sha256(archive_path.read_bytes()),
            "sourceLicense": SOURCE_LICENSE,
            "coordinateMapping": "STEP Z-up millimeters to application Y-up meters as [x, z, -y]",
            "urdfLinkWorldPositions": {
                link_name: list(position) for link_name, position in sorted(link_positions.items())
            },
            "sourceAlignment": {
                "matchedStepParts": len(step_members),
                "urdfLinkTransform": "Joint translations at the URDF zero pose",
                "maximumCollisionBoundsErrorMm": round(maximum_alignment_error, 3),
                "maximumAcceptedErrorMm": MAX_URDF_ALIGNMENT_ERROR_MM,
            },
        }
        return catalog, fixture_hashes
    finally:
        archive.close()


def _assign_inspection_offsets(nodes: list[dict[str, Any]]) -> None:
    by_id = {node["id"]: node for node in nodes}
    children: dict[str, list[dict[str, Any]]] = {node["id"]: [] for node in nodes}
    for node in nodes:
        parent_id = node["parentId"]
        if parent_id is not None:
            children[parent_id].append(node)
    centers: dict[str, list[float]] = {}

    def center(node: dict[str, Any]) -> list[float]:
        if node["id"] in centers:
            return centers[node["id"]]
        descendants = children[node["id"]]
        if descendants:
            points = [center(child) for child in descendants]
            position = [sum(point[axis] for point in points) / len(points) for axis in range(3)]
        else:
            position = list(node["restPositionMeters"])
        centers[node["id"]] = position
        return position

    for node in nodes:
        parent_id = node["parentId"]
        if parent_id is None:
            continue
        delta = [value - base for value, base in zip(center(node), center(by_id[parent_id]))]
        length = math.hypot(*delta)
        if length < 1e-6:
            digest = hashlib.sha256(node["id"].encode()).digest()
            delta = [int.from_bytes(digest[axis * 2:axis * 2 + 2], "big") / 32767.5 - 1 for axis in range(3)]
            length = math.hypot(*delta)
        node["explodeDirection"] = [value / length for value in delta]
        node["explodeDistanceMeters"] = max(0.025, min(0.12, max(node["dimensionsMm"]) / 2000))


def _load_catalog(catalog_path: Path) -> dict[str, Any]:
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    if catalog.get("archetypeId") != ARCHETYPE_ID or catalog.get("sourceCommit") != SOURCE_COMMIT:
        raise ValueError("Dual Scorpion catalog is not pinned to the supported source commit")
    return catalog


def prepare_pinned_source(
    archive_path: Path,
    cache_dir: Path,
    catalog_path: Path = CATALOG_PATH,
) -> dict[str, Any]:
    catalog = _load_catalog(catalog_path)
    archive, prefix = _read_archive(archive_path)
    try:
        source_files = {
            node["specifications"]["sourceOccurrencePath"]: node
            for node in catalog["nodes"]
            if node["level"] == "component"
        }
        archived_parts = {
            member[len(prefix):]: member
            for member in archive.namelist()
            if member.startswith(f"{prefix}STEP/follower/") and member.lower().endswith(".step")
        }
        if set(archived_parts) != set(source_files):
            raise ValueError("Source archive STEP part list differs from the pinned Dual Scorpion catalog")
        expected_urdf_sha = next(
            node["specifications"]["sourceSha256"]
            for node in catalog["nodes"]
            if node["id"] == ROOT_ID
        )
        urdf, urdf_bytes = _read_urdf(archive, prefix)
        if _sha256(urdf_bytes) != expected_urdf_sha:
            raise ValueError("Dual Scorpion URDF SHA-256 does not match the pinned catalog")
        license_bytes = archive.read(f"{prefix}LICENSE")
        if b"Apache License" not in license_bytes or b"Version 2.0" not in license_bytes:
            raise ValueError("Source archive does not contain the expected Apache-2.0 license")
        collision_parts = _collision_parts(urdf)
        if set(collision_parts) != {Path(path).stem.casefold() for path in source_files}:
            raise ValueError("Dual Scorpion URDF collision parts differ from the pinned catalog")
        link_positions = _link_world_positions(urdf)

        cache_dir.mkdir(parents=True, exist_ok=True)
        fixture_hashes: dict[str, str] = {}
        for source_path, node in source_files.items():
            source_bytes = archive.read(archived_parts[source_path])
            actual_sha256 = _sha256(source_bytes)
            expected_sha256 = node["specifications"]["sourceSha256"]
            if actual_sha256 != expected_sha256:
                raise ValueError(f"Dual Scorpion source SHA-256 mismatch for {source_path}")
            fixture_name = node["stepFixtureName"]
            shape, _, _, brep_valid = _read_source_shape(source_bytes, source_path)
            if fixture_name is None:
                if node["geometry"]["kind"] != "unavailable":
                    raise ValueError(f"Dual Scorpion source geometry unexpectedly became unavailable for {source_path}")
                continue
            if not brep_valid:
                raise ValueError(f"Dual Scorpion source STEP topology no longer validates for {source_path}")
            metadata = center_and_write_step(shape, cache_dir / fixture_name)
            expected_position = node["restPositionMeters"]
            if any(abs(actual - expected) > 0.000001 for actual, expected in zip(metadata["restPositionMeters"], expected_position)):
                raise ValueError(f"Dual Scorpion STEP transform differs from its pinned catalog for {source_path}")
            expected_dimensions = node["dimensionsMm"]
            source_dimensions = [metadata["dimensionsMm"][0], metadata["dimensionsMm"][2], metadata["dimensionsMm"][1]]
            if any(abs(actual - expected) > 0.01 for actual, expected in zip(source_dimensions, expected_dimensions)):
                raise ValueError(f"Dual Scorpion STEP dimensions differ from its pinned catalog for {source_path}")
            link_name = node["specifications"]["urdfLinkName"]
            expected_link_position = catalog["urdfLinkWorldPositions"][link_name]
            if any(abs(actual - expected) > 0.000001 for actual, expected in zip(link_positions[link_name], expected_link_position)):
                raise ValueError(f"Dual Scorpion URDF transform differs from its pinned catalog for {source_path}")
            fixture_hashes[fixture_name] = metadata["stepSha256"]
    finally:
        archive.close()

    for node in catalog["nodes"]:
        fixture_name = node["stepFixtureName"]
        if fixture_name is not None:
            node["expectedStepSha256"] = fixture_hashes[fixture_name]
    return catalog


def download_pinned_archive(destination: Path) -> Path:
    request = urllib.request.Request(
        SOURCE_ARCHIVE_URL,
        headers={"User-Agent": "zappd-cad-ingestor/1.0", "Accept": "application/zip"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        destination.write_bytes(response.read())
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description="Normalize the pinned Dual Scorpion source archive")
    parser.add_argument("--archive", required=True)
    parser.add_argument("--catalog-out", default=str(CATALOG_PATH))
    parser.add_argument("--cache-dir", default=str(REPO_ROOT / "backend" / "data" / "open_step_cache"))
    args = parser.parse_args()
    catalog, _ = _build_catalog_from_archive(Path(args.archive), Path(args.cache_dir))
    catalog_path = Path(args.catalog_out)
    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    catalog_path.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"archetypeId": ARCHETYPE_ID, "nodes": len(catalog["nodes"]), "components": sum(node["level"] == "component" for node in catalog["nodes"]), "catalog": str(catalog_path)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
