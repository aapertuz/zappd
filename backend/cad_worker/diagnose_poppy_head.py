from __future__ import annotations

import argparse
import json
from pathlib import Path

from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_Copy,
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_Sewing,
)
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
from OCP.BRepLib import BRepLib
from OCP.BRepTools import BRepTools
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.ShapeFix import ShapeFix_Face, ShapeFix_Shape, ShapeFix_Wire
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDF import TDF_Label, TDF_LabelSequence
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_WIRE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.XCAFDoc import XCAFDoc_DocumentTool

from ingest_upstream_catalog import exact_bounds_mm
from poppy_catalog import POPPY_SOURCE_SHA256, verify_poppy_source


def subshapes(shape, kind):
    explorer = TopExp_Explorer(shape, kind)
    while explorer.More():
        yield explorer.Current()
        explorer.Next()


def metrics(shape):
    properties = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, properties)
    area = properties.Mass()
    BRepGProp.VolumeProperties_s(shape, properties)
    return {
        "valid": BRepCheck_Analyzer(shape).IsValid(),
        "faces": len(list(subshapes(shape, TopAbs_FACE))),
        "areaMm2": area,
        "signedVolumeMm3": properties.Mass(),
        "boundsMm": exact_bounds_mm(shape),
        "maxEdgeToleranceMm": max(
            BRep_Tool.Tolerance_s(TopoDS.Edge_s(edge))
            for edge in subshapes(shape, TopAbs_EDGE)
        ),
    }


def head_definition(source):
    verify_poppy_source(source.read_bytes())
    document = TDocStd_Document(TCollection_ExtendedString("Poppy diagnosis"))
    reader = STEPCAFControl_Reader()
    if reader.ReadFile(str(source)) != IFSelect_RetDone or not reader.Transfer(document):
        raise RuntimeError("Cannot transfer pinned source")
    tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    labels = TDF_LabelSequence()
    tool.GetFreeShapes(labels)
    label = labels.Value(1)
    for tag in (28, 5):
        definition = TDF_Label()
        if tool.GetReferredShape_s(label, definition):
            label = definition
        children = TDF_LabelSequence()
        tool.GetComponents_s(label, children)
        label = next(
            children.Value(i)
            for i in range(1, children.Length() + 1)
            if children.Value(i).Tag() == tag
        )
    definition = TDF_Label()
    if tool.GetReferredShape_s(label, definition):
        label = definition
    return tool.GetShape_s(label)


def diagnose(source):
    shape = head_definition(source)
    defects = []
    for index, raw_face in enumerate(subshapes(shape, TopAbs_FACE), 1):
        face = TopoDS.Face_s(raw_face)
        if BRepCheck_Analyzer(face).IsValid():
            continue
        edges = []
        for raw_edge in subshapes(face, TopAbs_EDGE):
            edge = TopoDS.Edge_s(raw_edge)
            curve = BRepAdaptor_Curve(edge)
            pcurve = BRep_Tool.CurveOnSurface_s(edge, face, 0.0, 0.0)
            parameters = [
                curve.FirstParameter()
                + (curve.LastParameter() - curve.FirstParameter()) * t / 4
                for t in range(5)
            ]
            edges.append({
                "curve": str(curve.GetType()),
                "degenerate": BRep_Tool.Degenerated_s(edge),
                "seam": BRep_Tool.IsClosed_s(edge, face),
                "sameParameter": BRep_Tool.SameParameter_s(edge),
                "pcurveSamples": [pcurve.Value(t).Coord() for t in parameters],
                "surfaceResidualMm": max(curve.Value(t).Distance(BRepAdaptor_Surface(face).Value(pcurve.Value(t).X(), pcurve.Value(t).Y())) for t in parameters),
                "adjacentFaces": sum(any(edge.IsSame(other) for other in subshapes(candidate, TopAbs_EDGE)) for candidate in subshapes(shape, TopAbs_FACE)),
            })
        face_fix = ShapeFix_Face(TopoDS.Face_s(BRepBuilderAPI_Copy(face).Shape()))
        face_fix.Perform()
        seam_fix = ShapeFix_Face(TopoDS.Face_s(BRepBuilderAPI_Copy(face).Shape()))
        periodic_changed = seam_fix.FixPeriodicDegenerated()
        seam_changed = seam_fix.FixMissingSeam()
        wire_results = []
        for wire in subshapes(face, TopAbs_WIRE):
            wire_face = TopoDS.Face_s(BRepBuilderAPI_Copy(face).Shape())
            wire_copy = next(subshapes(wire_face, TopAbs_WIRE))
            fix = ShapeFix_Wire(TopoDS.Wire_s(wire_copy), wire_face, 1e-7)
            changed = fix.FixEdgeCurves()
            rebuilt_face = BRepBuilderAPI_MakeFace(BRep_Tool.Surface_s(wire_face), fix.Wire()).Face()
            wire_results.append({"changed": changed, "result": metrics(rebuilt_face)})
        defects.append({
            "face": index,
            "surface": str(BRepAdaptor_Surface(face).GetType()),
            "uvBounds": BRepTools.UVBounds_s(face),
            "metrics": metrics(face),
            "edges": edges,
            "faceHealing": metrics(face_fix.Face()),
            "wireEdgeCurveFix": wire_results,
            "periodicDegeneratedChanged": periodic_changed,
            "missingSeamChanged": seam_changed,
            "seamHealing": metrics(seam_fix.Face()),
        })
    attempts = {}
    parameter_shape = BRepBuilderAPI_Copy(shape).Shape()
    BRepLib.SameParameter_s(parameter_shape, 1e-7, True)
    attempts["forcedSameParameter"] = metrics(parameter_shape)
    shape_fix = ShapeFix_Shape(BRepBuilderAPI_Copy(shape).Shape())
    shape_fix.Perform()
    attempts["shapeHealing"] = metrics(shape_fix.Shape())
    sewing = BRepBuilderAPI_Sewing(1e-7)
    sewing.Add(BRepBuilderAPI_Copy(shape).Shape())
    sewing.Perform()
    attempts["sewing"] = metrics(sewing.SewedShape())
    return {
        "sourceSha256": POPPY_SOURCE_SHA256,
        "occurrence": "1_28_5",
        "original": metrics(shape),
        "defects": defects,
        "attempts": attempts,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    arguments = parser.parse_args()
    arguments.output.write_text(json.dumps(diagnose(arguments.source), indent=2) + "\n")
