from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from diagnose_poppy_head import head_definition, metrics, removal_diagnosis, subshapes
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepTools import BRepTools
from OCP.GeomAbs import GeomAbs_Cylinder
from OCP.TopAbs import TopAbs_FACE
from OCP.TopoDS import TopoDS


@pytest.fixture(scope="module")
def pinned_head_shape():
    source = os.environ.get("ZAPPD_POPPY_SOURCE")
    if source is None:
        pytest.skip("Set ZAPPD_POPPY_SOURCE to the pinned upstream STEP")
    return head_definition(Path(source))


def test_pinned_head_contains_zero_height_cylindrical_faces(pinned_head_shape):
    shape = pinned_head_shape
    assert not BRepCheck_Analyzer(shape).IsValid()
    defects = []
    for index, raw_face in enumerate(subshapes(shape, TopAbs_FACE), 1):
        face = TopoDS.Face(raw_face)
        if BRepCheck_Analyzer(face).IsValid():
            continue
        defects.append(index)
        assert BRepAdaptor_Surface(face).GetType() == GeomAbs_Cylinder
        umin, umax, vmin, vmax = BRepTools.UVBounds_s(face)
        assert umax - umin == pytest.approx(2 * 3.141592653589793)
        assert vmin == vmax
        assert metrics(face)["areaMm2"] == 0
    assert len(defects) == 2


def test_degenerate_face_removal_cannot_publish_a_closed_head(pinned_head_shape):
    shape = pinned_head_shape
    original = metrics(shape)
    removal = removal_diagnosis(shape)
    assert removal["result"]["valid"]
    assert removal["resultShapeType"] == "TopAbs_ShapeEnum.TopAbs_SHELL"
    assert removal["resultSolidCount"] == 0
    assert removal["resultShellCount"] == 1
    assert removal["result"]["faces"] == 794
    assert removal["result"]["areaMm2"] == original["areaMm2"]
    assert removal["result"]["boundsMm"] == original["boundsMm"]
    assert removal["result"]["maxEdgeToleranceMm"] == original["maxEdgeToleranceMm"]
    assert not removal["closed"]
    assert removal["freeEdges"] == 4
    assert removal["multipleEdges"] == 0
    assert not removal["healedClosed"]
    assert removal["healedFreeEdges"] == 4
    assert len(removal["boundaries"]) == 4
    assert {round(boundary["centerMm"][0], 3) for boundary in removal["boundaries"]} == {-46.5, 46.5}
    for boundary in removal["boundaries"]:
        assert abs(boundary["centerMm"][0]) == pytest.approx(46.5)
        assert boundary["centerMm"][1:] == pytest.approx(
            (10.932446485240638, 29.409891266940623)
        )
        assert boundary["radiusMm"] == pytest.approx(1.35)
        assert boundary["parameterSpan"] == pytest.approx(3.141592653589793)
        assert len(boundary["remainingAdjacentFaces"]) == 1
        assert boundary["remainingAdjacentSurfaces"] == [
            "GeomAbs_SurfaceType.GeomAbs_Plane"
        ]
        assert boundary["remainingAdjacentFaceWireCounts"] == [2]
