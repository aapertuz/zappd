from __future__ import annotations

import hashlib
import math
import re
from pathlib import Path
from tempfile import TemporaryDirectory

from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.TopAbs import TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label
from OCP.TDocStd import TDocStd_Document
from OCP.TopLoc import TopLoc_Location
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.collections import Sequence_TDF_Label

from catalog_ingestor import stabilize_step_occurrences
from ingest_upstream_catalog import center_and_write_step, exact_bounds_mm
from poppy_explode import assign_inspection_offsets

POPPY_SOURCE_URL = "https://github.com/poppy-project/poppy-humanoid/releases/download/1.0.2/Poppy_Humanoid.STEP"
POPPY_SOURCE_SHA256 = "10e9d997f82787d4069f7edd4b88ec3ab6dcc51cb1686d761d84add709d38266"
POPPY_STEP_TIMESTAMP = "2015-03-19T00:00:00"
_STEP_TRANSLATOR_COUNTER = re.compile(r"Open CASCADE STEP translator (\d+\.\d+) \d+")
POPPY_SPEC_PATH = (
    Path(__file__).resolve().parents[2]
    / "src"
    / "shared"
    / "domain"
    / "catalog"
    / "assemblies"
    / "poppy_humanoid_v1.json"
)


def verify_poppy_source(payload: bytes) -> None:
    if hashlib.sha256(payload).hexdigest() != POPPY_SOURCE_SHA256:
        raise ValueError("Poppy Humanoid release STEP SHA-256 mismatch")


def import_poppy(source_path: Path, cache_dir: Path) -> dict:
    verify_poppy_source(source_path.read_bytes())
    with TemporaryDirectory(prefix="zappd-poppy-") as temporary:
        staging_dir = Path(temporary)
        catalog = _import_poppy(source_path, staging_dir)
        cache_dir.mkdir(parents=True, exist_ok=True)
        for fixture in staging_dir.iterdir():
            (cache_dir / fixture.name).write_bytes(fixture.read_bytes())
        return catalog


def compose_poppy_catalog(source_path: Path, cache_dir: Path) -> dict:
    from poppy_electronics import apply_poppy_electronics

    return apply_poppy_electronics(import_poppy(source_path, cache_dir), cache_dir)


def _import_poppy(source_path: Path, cache_dir: Path) -> dict:
    document = TDocStd_Document(TCollection_ExtendedString("Poppy Humanoid"))
    reader = STEPCAFControl_Reader()
    if reader.ReadFile(str(source_path)) != IFSelect_RetDone or not reader.Transfer(
        document
    ):
        raise RuntimeError("Cannot transfer Poppy Humanoid STEP assembly")
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    roots = Sequence_TDF_Label()
    shape_tool.GetFreeShapes(roots)
    if roots.Length() != 1:
        raise RuntimeError("Expected one Poppy Humanoid assembly root")
    nodes = []
    source_to_z_up = gp_Trsf()
    source_to_z_up.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(1, 0, 0)), math.pi / 2)

    def visit(label, parent_id, path, location, depth):
        definition = TDF_Label()
        if not shape_tool.GetReferredShape_s(label, definition):
            definition = label
        world_location = location.Multiplied(shape_tool.GetLocation_s(label))
        name_attribute = TDataStd_Name()
        name = (
            name_attribute.Get().ToExtString()
            if definition.FindAttribute(TDataStd_Name.GetID_s(), name_attribute)
            else path
        )
        children = Sequence_TDF_Label()
        shape_tool.GetComponents_s(definition, children)
        dimensions = [0.0, 0.0, 0.0]
        bounds_min = bounds_max = None
        node_id = f"poppy_{path}"
        fixture = None
        metadata = {}
        if children.Length() == 0:
            shape = shape_tool.GetShape_s(definition).Moved(world_location)
            shape = BRepBuilderAPI_Transform(shape, source_to_z_up, True).Shape()
            bounds_min, bounds_max = exact_bounds_mm(shape)
            dimensions = [round(b - a, 2) for a, b in zip(bounds_min, bounds_max)]
            fixture = f"{node_id}.step"
            if BRepCheck_Analyzer(shape).IsValid():
                fixture_path = cache_dir / fixture
                metadata = center_and_write_step(
                    shape, fixture_path, timestamp=POPPY_STEP_TIMESTAMP
                )
                normalized_step = _STEP_TRANSLATOR_COUNTER.sub(
                    r"Open CASCADE STEP translator \1 1",
                    stabilize_step_occurrences(fixture_path.read_text(encoding="ascii")),
                )
                fixture_path.write_text(normalized_step, encoding="ascii")
                metadata["stepSha256"] = hashlib.sha256(fixture_path.read_bytes()).hexdigest()
                solids = TopExp_Explorer(shape, TopAbs_SOLID)
                geometry = {"kind": "available", "role": "solid" if solids.More() else "surface"}
            else:
                fixture = None
                center = [(a + b) / 2 for a, b in zip(bounds_min, bounds_max)]
                metadata = {"restPositionMeters": [center[0] / 1000, center[2] / 1000, -center[1] / 1000]}
                geometry = {"kind": "unavailable", "reason": "Source BRep topology validation failed; geometry excluded"}
        else:
            geometry = {"kind": "assembly"}
        node = {
            "id": node_id,
            "geometry": geometry,
            "parentId": parent_id,
            "name": name,
            "level": (
                "project"
                if depth == 0
                else "subsystem" if children.Length() else "component"
            ),
            "depth": depth,
            "category": "assembly" if children.Length() else "cad_part",
            "colorHex": "#cbd5e1",
            "dimensionsMm": dimensions,
            "restPositionMeters": metadata.get("restPositionMeters", [0.0, 0.0, 0.0]),
            "explodeDirection": [0.0, 0.0, 0.0],
            "explodeDistanceMeters": 0.0,
            "materialHint": "unspecified",
            "origin": "open_step_catalog",
            "spdxLicense": "CC-BY-SA-4.0",
            "sourceUrl": POPPY_SOURCE_URL,
            "sourceName": "Poppy project and authors, Poppy Humanoid hardware 1.0.2",
            "stepFixtureName": fixture,
            "specifications": {
                "sourceSha256": POPPY_SOURCE_SHA256,
                "sourceOccurrencePath": path,
                "engineeringValidation": "Not established by CAD import",
                "brepFaces": metadata.get("faceCount", 0),
                "geometryStatus": geometry["kind"],
                "geometryDetail": geometry.get("reason", geometry.get("role", "hierarchy")),
            },
            **({"expectedStepSha256": metadata["stepSha256"]} if fixture and metadata else {}),
        }
        nodes.append(node)
        child_bounds = []
        for index in range(1, children.Length() + 1):
            occurrence = children.Value(index)
            child_bounds.append(
                visit(
                    occurrence,
                    node_id,
                    f"{path}_{occurrence.Tag()}",
                    world_location,
                    depth + 1,
                )
            )
        if child_bounds:
            bounds_min = tuple(
                min(bounds[0][axis] for bounds in child_bounds) for axis in range(3)
            )
            bounds_max = tuple(
                max(bounds[1][axis] for bounds in child_bounds) for axis in range(3)
            )
            node["dimensionsMm"] = [
                round(b - a, 2) for a, b in zip(bounds_min, bounds_max)
            ]
        return bounds_min, bounds_max

    visit(roots.Value(1), None, str(roots.Value(1).Tag()), TopLoc_Location(), 0)
    assign_inspection_offsets(nodes)
    return {
        "semantics": "source_inspection",
        "archetypeId": "poppy_humanoid_v1",
        "title": "Poppy Humanoid source CAD inspection",
        "commercialName": "Poppy Mark I",
        "summary": (
            "Official Poppy Humanoid 1.0.2 source assembly. Front shell uses an official "
            "visual-only mesh; head_face CAD remains rejected. Engineering validation is not "
            "established. CC-BY-SA-4.0, Poppy project and authors."
        ),
        "keywords": ["poppy", "humanoid", "biped"],
        "rootNodeId": nodes[0]["id"],
        "nodes": nodes,
        "relationships": [],
        "assemblySteps": [],
    }
