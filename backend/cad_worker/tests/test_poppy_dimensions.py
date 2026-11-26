from pathlib import Path
import sys

import pytest
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCP.gp import gp_Pnt

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from diagnose_poppy_dimensions import inspect_dimensions


def test_dimension_diagnostic_preserves_fixture_and_measures_cad_axes(tmp_path):
    path = tmp_path / "offset_box.step"
    writer = STEPControl_Writer()
    writer.Transfer(BRepPrimAPI_MakeBox(gp_Pnt(-3, 7, 11), 2, 4, 6).Shape(), STEPControl_AsIs)
    writer.Write(str(path))
    original = path.read_bytes()
    result = inspect_dimensions(path, (0.2, 0.02))
    assert path.read_bytes() == original
    for run in result["runs"]:
        assert run["mesherStatusFlags"] == 0
        assert run["missingTriangulationFaces"] == []
        assert run["facesExceedingTolerance"] == []
        assert run["meshBoundsMm"][0] == pytest.approx([-3, 7, 11])
        assert run["meshBoundsMm"][1] == pytest.approx([-1, 11, 17])
        assert run["maxBoundDifferenceMm"] < 1e-5
