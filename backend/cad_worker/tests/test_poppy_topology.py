from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from diagnose_poppy_head import head_definition, metrics, subshapes
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepTools import BRepTools
from OCP.GeomAbs import GeomAbs_Cylinder
from OCP.TopAbs import TopAbs_FACE
from OCP.TopoDS import TopoDS


def test_pinned_head_contains_zero_height_cylindrical_faces():
    source = os.environ.get("ZAPPD_POPPY_SOURCE")
    if source is None:
        pytest.skip("Set ZAPPD_POPPY_SOURCE to the pinned upstream STEP")
    shape = head_definition(Path(source))
    assert not BRepCheck_Analyzer(shape).IsValid()
    defects = []
    for index, raw_face in enumerate(subshapes(shape, TopAbs_FACE), 1):
        face = TopoDS.Face_s(raw_face)
        if BRepCheck_Analyzer(face).IsValid():
            continue
        defects.append(index)
        assert BRepAdaptor_Surface(face).GetType() == GeomAbs_Cylinder
        umin, umax, vmin, vmax = BRepTools.UVBounds_s(face)
        assert umax - umin == pytest.approx(2 * 3.141592653589793)
        assert vmin == vmax
        assert metrics(face)["areaMm2"] == 0
    assert defects == [86, 489]
