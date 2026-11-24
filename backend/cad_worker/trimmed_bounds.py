from itertools import product

from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepTools import BRepTools
from OCP.BRepClass import BRepClass_FaceClassifier
from OCP.TopAbs import TopAbs_IN, TopAbs_ON
from OCP.TopoDS import TopoDS
from OCP.gp import gp_Pnt, gp_Vec, gp_Pnt2d
from OCP.GeomAbs import GeomAbs_BSplineSurface

import numpy as np
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.gp import gp_Pln, gp_Dir


def conservative_bounds(shape):
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    box.SetGap(0.0)
    return np.array(box.Get()).reshape(2, 3)


def solve_stationary_point(surface, axis, start, parameter_bounds):
    u, v = start
    u_min, u_max, v_min, v_max = parameter_bounds
    for _ in range(40):
        point = gp_Pnt()
        du, dv, duu, dvv, duv = (gp_Vec() for _ in range(5))
        surface.D2(u, v, point, du, dv, duu, dvv, duv)
        gradient = np.array([du.Coord(axis + 1), dv.Coord(axis + 1)])
        if np.linalg.norm(gradient) < 1e-8:
            return u, v, [point.X(), point.Y(), point.Z()]
        hessian = np.array(
            [
                [duu.Coord(axis + 1), duv.Coord(axis + 1)],
                [duv.Coord(axis + 1), dvv.Coord(axis + 1)],
            ]
        )
        if abs(np.linalg.det(hessian)) < 1e-18:
            return None
        step = np.linalg.solve(hessian, gradient)
        scale = 1.0
        while scale > 1e-6:
            next_u, next_v = u - step[0] * scale, v - step[1] * scale
            if u_min <= next_u <= u_max and v_min <= next_v <= v_max:
                break
            scale *= 0.5
        if scale <= 1e-6:
            return None
        u, v = next_u, next_v
    return None


def stationary_points(face, bounds):
    face = TopoDS.Face_s(face)
    surface = BRepAdaptor_Surface(face)
    if surface.GetType() != GeomAbs_BSplineSurface:
        return []
    parameter_bounds = BRepTools.UVBounds_s(face)
    u_min, u_max, v_min, v_max = parameter_bounds
    spline = surface.BSpline()
    u_knots = sorted(
        {u_min, u_max}
        | {
            spline.UKnot(i)
            for i in range(1, spline.NbUKnots() + 1)
            if u_min < spline.UKnot(i) < u_max
        }
    )
    v_knots = sorted(
        {v_min, v_max}
        | {
            spline.VKnot(i)
            for i in range(1, spline.NbVKnots() + 1)
            if v_min < spline.VKnot(i) < v_max
        }
    )
    seeds = [
        (u_low + (u_high - u_low) * u_fraction, v_low + (v_high - v_low) * v_fraction)
        for (u_low, u_high), (v_low, v_high), u_fraction, v_fraction in product(
            zip(u_knots, u_knots[1:]),
            zip(v_knots, v_knots[1:]),
            (0.2, 0.5, 0.8),
            (0.2, 0.5, 0.8),
        )
    ]
    result = []
    face_bounds = conservative_bounds(face)
    for axis in range(3):
        if (
            face_bounds[0][axis] >= bounds[0][axis] - 1e-5
            and face_bounds[1][axis] <= bounds[1][axis] + 1e-5
        ):
            continue
        for seed in seeds:
            solution = solve_stationary_point(surface, axis, seed, parameter_bounds)
            if solution is None:
                continue
            u, v, point = solution
            if BRepClass_FaceClassifier(face, gp_Pnt2d(u, v), 1e-7).State() in (
                TopAbs_IN,
                TopAbs_ON,
            ):
                result.append(point)
    return result


def trimmed_shape_bounds_mm(shape):
    conservative = conservative_bounds(shape)
    faces = TopExp_Explorer(shape, TopAbs_FACE)
    has_bspline = False
    while faces.More():
        has_bspline = (
            has_bspline
            or BRepAdaptor_Surface(TopoDS.Face_s(faces.Current())).GetType()
            == GeomAbs_BSplineSurface
        )
        faces.Next()
    if not has_bspline:
        return tuple(conservative[0]), tuple(conservative[1])
    bounds = np.array([[np.inf] * 3, [-np.inf] * 3])
    edges = TopExp_Explorer(shape, TopAbs_EDGE)
    while edges.More():
        edge_bounds = conservative_bounds(edges.Current())
        bounds[0] = np.minimum(bounds[0], edge_bounds[0])
        bounds[1] = np.maximum(bounds[1], edge_bounds[1])
        edges.Next()
    for side in range(2):
        for axis in range(3):
            origin = [0.0] * 3
            origin[axis] = conservative[side, axis] + (-100 if side == 0 else 100)
            direction = [0.0] * 3
            direction[axis] = 1.0
            plane = BRepBuilderAPI_MakeFace(
                gp_Pln(gp_Pnt(*origin), gp_Dir(*direction))
            ).Face()
            extrema = BRepExtrema_DistShapeShape(shape, plane, 1e-7)
            if not extrema.IsDone():
                raise RuntimeError("Trimmed CAD plane extrema did not converge")
            coordinate = origin[axis] + (1 if side == 0 else -1) * extrema.Value()
            bounds[side, axis] = (min if side == 0 else max)(
                bounds[side, axis], coordinate
            )
    faces = TopExp_Explorer(shape, TopAbs_FACE)
    while faces.More():
        for point in stationary_points(faces.Current(), bounds):
            bounds[0] = np.minimum(bounds[0], point)
            bounds[1] = np.maximum(bounds[1], point)
        faces.Next()
    if not np.isfinite(bounds).all():
        raise RuntimeError("Trimmed CAD bounds are not finite")
    return tuple(bounds[0]), tuple(bounds[1])
