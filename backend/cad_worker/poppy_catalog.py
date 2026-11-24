from __future__ import annotations

import hashlib
import math
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
from OCP.TDF import TDF_Label, TDF_LabelSequence
from OCP.TDocStd import TDocStd_Document
from OCP.TopLoc import TopLoc_Location
from OCP.XCAFDoc import XCAFDoc_DocumentTool

from ingest_upstream_catalog import center_and_write_step, exact_bounds_mm

POPPY_SOURCE_URL = "https://github.com/poppy-project/poppy-humanoid/releases/download/1.0.2/Poppy_Humanoid.STEP"
POPPY_SOURCE_SHA256 = "10e9d997f82787d4069f7edd4b88ec3ab6dcc51cb1686d761d84add709d38266"
POPPY_SPEC_PATH = Path(__file__).resolve().parents[1] / "data/poppy-catalog.json"


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


def _import_poppy(source_path: Path, cache_dir: Path) -> dict:
    document = TDocStd_Document(TCollection_ExtendedString("Poppy Humanoid"))
    reader = STEPCAFControl_Reader()
    if reader.ReadFile(str(source_path)) != IFSelect_RetDone or not reader.Transfer(
        document
    ):
        raise RuntimeError("Cannot transfer Poppy Humanoid STEP assembly")
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    roots = TDF_LabelSequence()
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
        children = TDF_LabelSequence()
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
                metadata = center_and_write_step(shape, cache_dir / fixture)
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
    return {"archetypeId": "poppy_humanoid_v1", "nodes": nodes}
