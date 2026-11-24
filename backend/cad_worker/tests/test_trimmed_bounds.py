from OCP.TColgp import TColgp_Array2OfPnt
from OCP.gp import gp_Pnt
from OCP.Geom import Geom_BezierSurface
from OCP.GeomConvert import GeomConvert
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
import sys
from pathlib import Path
import pytest
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from trimmed_bounds import trimmed_shape_bounds_mm


def test_trimmed_bspline_has_boundary_and_interior_extrema():
    poles = TColgp_Array2OfPnt(1, 3, 1, 3)
    for i in range(3):
        for j in range(3):
            poles.SetValue(
                i + 1, j + 1, gp_Pnt(i / 2, j / 2, ([0, 2, 0][i] + [0, 2, 0][j]))
            )
    s = GeomConvert.SurfaceToBSplineSurface_s(Geom_BezierSurface(poles))
    f = BRepBuilderAPI_MakeFace(s, 0, 0.75, 0, 0.75, 1e-7).Face()
    bounds = np.array(trimmed_shape_bounds_mm(f))
    assert bounds[0] == pytest.approx([0, 0, 0], abs=2e-7)
    assert bounds[1] == pytest.approx([0.75, 0.75, 2], abs=2e-7)


@pytest.mark.parametrize(
    "component_id",
    ["poppy_1_10", "poppy_1_11", "poppy_1_21_2", "poppy_1_25_2", "poppy_1_28_7"],
)
def test_actual_poppy_trimmed_bounds(component_id):
    from OCP.STEPControl import STEPControl_Reader
    from geometry_pipeline import tessellate_shape_meters_y_up

    fixture = (
        Path(__file__).resolve().parents[2]
        / "data/open_step_cache"
        / f"{component_id}.step"
    )
    if not fixture.exists():
        pytest.skip("Authentic upstream Poppy fixture is not cached")
    reader = STEPControl_Reader()
    reader.ReadFile(str(fixture))
    reader.TransferRoots()
    shape = reader.OneShape()
    bounds = np.array(trimmed_shape_bounds_mm(shape))
    vertices, _, _ = tessellate_shape_meters_y_up(shape)
    cad_coordinates = vertices[:, [0, 2, 1]] * np.array([1000, -1000, 1000])
    mesh_bounds = np.array([cad_coordinates.min(0), cad_coordinates.max(0)])
    assert np.abs(bounds - mesh_bounds).max() < 0.1
    changed_mesh_bounds = mesh_bounds + 1
    assert np.abs(bounds - changed_mesh_bounds).max() > 0.1


def test_pipeline_rejects_shifted_render_geometry(tmp_path, monkeypatch):
    import copy
    import geometry_pipeline
    from catalog_specs import CATALOG_SPECS

    spec = copy.deepcopy(CATALOG_SPECS["quadcopter_drone_v1"])
    spec["nodes"] = [
        node
        for node in spec["nodes"]
        if node["id"] in ("proj_quadcopter", "sub_chassis", "comp_base_plate_lower")
    ]
    tessellate = geometry_pipeline.tessellate_shape_meters_y_up

    def shifted_mesh(shape):
        vertices, normals, indices = tessellate(shape)
        return vertices + np.array([0.001, 0, 0]), normals, indices

    monkeypatch.setattr(geometry_pipeline, "tessellate_shape_meters_y_up", shifted_mesh)
    result = geometry_pipeline.run_cad_pipeline(
        spec, tmp_path / "exports", tmp_path / "cache", check_interference=False
    )
    assert result["validation"]["maxDimensionalErrorMm"] > 0.9
    assert any(
        "Dimensional tolerance exceeded" in failure
        for failure in result["validation"]["failures"]
    )


def test_nonrectangular_trim_excludes_underlying_surface_maximum():
    poles = TColgp_Array2OfPnt(1, 3, 1, 3)
    for i in range(3):
        for j in range(3):
            poles.SetValue(
                i + 1, j + 1, gp_Pnt(i / 2, j / 2, ([0, 2, 0][i] + [0, 2, 0][j]))
            )
    s = GeomConvert.SurfaceToBSplineSurface_s(Geom_BezierSurface(poles))
    from OCP.Geom2d import Geom2d_Line, Geom2d_TrimmedCurve
    from OCP.gp import gp_Pnt2d, gp_Dir2d
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeWire
    from OCP.BRepLib import BRepLib

    wire = BRepBuilderAPI_MakeWire()
    for x, y, xx, yy in [(0, 0, 0.5, 0), (0.5, 0, 0, 0.5), (0, 0.5, 0, 0)]:
        line = Geom2d_Line(gp_Pnt2d(x, y), gp_Dir2d(xx - x, yy - y))
        curve = Geom2d_TrimmedCurve(line, 0, ((xx - x) ** 2 + (yy - y) ** 2) ** 0.5)
        wire.Add(BRepBuilderAPI_MakeEdge(curve, s).Edge())
    f = BRepBuilderAPI_MakeFace(s, wire.Wire(), True).Face()
    BRepLib.BuildCurves3d_s(f)
    bounds = np.array(trimmed_shape_bounds_mm(f))
    assert bounds[0] == pytest.approx([0, 0, 0], abs=2e-7)
    assert bounds[1] == pytest.approx([0.5, 0.5, 1.5], abs=2e-7)
