from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepClass import BRepClass_FaceClassifier
from OCP.gp import gp_Pnt2d
from OCP.BRepTools import BRepTools
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_FACE, TopAbs_IN, TopAbs_ON
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS

from geometry_pipeline import shape_bounds_mm

COMPONENT_IDS = (
    "poppy_1_10", "poppy_1_11", "poppy_1_21_2", "poppy_1_25_2", "poppy_1_28_7"
)


def sample_face_bounds(face) -> dict:
    surface = BRepAdaptor_Surface(face)
    umin, umax, vmin, vmax = BRepTools.UVBounds_s(face)
    rectangle = []
    trimmed = []
    for u in np.linspace(umin, umax, 151):
        for v in np.linspace(vmin, vmax, 151):
            point = surface.Value(u, v)
            coordinates = [point.X(), point.Y(), point.Z()]
            rectangle.append(coordinates)
            if BRepClass_FaceClassifier(face, gp_Pnt2d(u, v), 1e-7).State() in (TopAbs_IN, TopAbs_ON):
                trimmed.append(coordinates)
    return {
        "gridSize": 151,
        "uvRectangleSampleBoundsMm": [np.min(rectangle, axis=0).tolist(), np.max(rectangle, axis=0).tolist()],
        "trimmedSampleBoundsMm": [np.min(trimmed, axis=0).tolist(), np.max(trimmed, axis=0).tolist()] if trimmed else None,
        "limitation": "Finite samples do not certify global extrema",
    }


def inspect_dimensions(step_path: Path, deflections: tuple[float, ...]) -> dict:
    reader = STEPControl_Reader()
    if reader.ReadFile(str(step_path)) != IFSelect_RetDone:
        raise RuntimeError(f"Cannot read {step_path}")
    reader.TransferRoots()
    shape = reader.OneShape()
    bounds = np.array(shape_bounds_mm(shape))
    runs = []
    for deflection in deflections:
        BRepTools.Clean_s(shape)
        mesher = BRepMesh_IncrementalMesh(shape, deflection, False, 0.1, True)
        explorer = TopExp_Explorer(shape, TopAbs_FACE)
        vertices = []
        faces = []
        missing = []
        index = 0
        while explorer.More():
            index += 1
            face = TopoDS.Face(explorer.Current())
            location = TopLoc_Location()
            triangulation = BRep_Tool.Triangulation_s(face, location)
            if triangulation is None:
                missing.append(index)
            else:
                points = []
                for node in range(1, triangulation.NbNodes() + 1):
                    point = triangulation.Node(node).Transformed(location.Transformation())
                    points.append([point.X(), point.Y(), point.Z()])
                points = np.array(points)
                vertices.extend(points)
                mesh_bounds = np.array([points.min(axis=0), points.max(axis=0)])
                face_bounds = np.array(shape_bounds_mm(face))
                error = float(np.abs(face_bounds - mesh_bounds).max())
                if error > 0.1:
                    surface = BRepAdaptor_Surface(face)
                    faces.append({
                        "faceIndex": index,
                        "surfaceType": str(surface.GetType()),
                        "brepBoundsMm": face_bounds.tolist(),
                        "meshBoundsMm": mesh_bounds.tolist(),
                        "maxBoundDifferenceMm": error,
                        "uvBounds": list(BRepTools.UVBounds_s(face)),
                    })
            explorer.Next()
        vertices = np.array(vertices)
        mesh_bounds = np.array([vertices.min(axis=0), vertices.max(axis=0)])
        runs.append({
            "linearDeflectionMm": deflection,
            "angularDeflectionRadians": 0.1,
            "mesherStatusFlags": mesher.GetStatusFlags(),
            "missingTriangulationFaces": missing,
            "meshBoundsMm": mesh_bounds.tolist(),
            "maxBoundDifferenceMm": float(np.abs(bounds - mesh_bounds).max()),
            "facesExceedingTolerance": faces,
        })
    discrepant_faces = runs[-1]["facesExceedingTolerance"]
    worst_face_samples = None
    if discrepant_faces:
        worst_face = max(discrepant_faces, key=lambda face: face["maxBoundDifferenceMm"])
        explorer = TopExp_Explorer(shape, TopAbs_FACE)
        for _ in range(worst_face["faceIndex"] - 1):
            explorer.Next()
        worst_face_samples = {"faceIndex": worst_face["faceIndex"], **sample_face_bounds(TopoDS.Face(explorer.Current()))}
    return {
        "worstFaceSamples": worst_face_samples,
        "componentId": step_path.stem,
        "fixtureSha256": hashlib.sha256(step_path.read_bytes()).hexdigest(),
        "brepBoundsMm": bounds.tolist(),
        "runs": runs,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("cache", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = {
        "purpose": "Compare triangulation-independent AddOptimal bounds with fresh mesh bounds; neither is a certified surface-extrema calculation",
        "components": [inspect_dimensions(args.cache / f"{cid}.step", (0.2, 0.02, 0.002)) for cid in COMPONENT_IDS],
    }
    args.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
