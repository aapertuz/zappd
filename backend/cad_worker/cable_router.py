from __future__ import annotations

from itertools import combinations
from math import acos, pi, tan
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import numpy as np
from OCP.APIHeaderSection import APIHeaderSection_MakeHeader
from OCP.BRep import BRep_Builder
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_MakeEdge,
    BRepBuilderAPI_MakeWire,
    BRepBuilderAPI_RoundCorner,
)
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepGProp import BRepGProp
from OCP.BRepOffsetAPI import BRepOffsetAPI_MakePipeShell
from OCP.GC import GC_MakeArcOfCircle
from OCP.Geom import Geom_BSplineCurve
from OCP.GeomAPI import GeomAPI_Interpolate, GeomAPI_PointsToBSpline
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.Quantity import Quantity_Color, Quantity_TOC_sRGB
from OCP.STEPControl import STEPControl_AsIs
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.StepRepr import StepRepr_NextAssemblyUsageOccurrence
from OCP.TCollection import TCollection_ExtendedString, TCollection_HAsciiString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS_Compound, TopoDS_Iterator, TopoDS_Shape, TopoDS_Wire
from OCP.XCAFDoc import XCAFDoc_ColorGen, XCAFDoc_DocumentTool, XCAFDoc_Editor
from OCP.collections import Array1_gp_Pnt, HArray1_double, HArray1_gp_Pnt, Sequence_TDF_Label
from OCP.gp import gp_Ax2, gp_Circ, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

from cad_pose import rotate_vector, world_rest_to_cad_mm, world_rotation
from routing_paths import RoutingSpace, channel_paths, escape_port, routing_boxes, voxel_path
from validation_checks import INTERFERENCE_TOLERANCE_MM3, bounds_distance_mm

from catalog_ingestor import (
    GEOMETRY_ORIGIN_POLICY,
    MIN_CAD_BREP_FACES,
    count_brep_faces,
    node_provenance_failure,
    read_and_validate_step,
    read_step_digest,
    read_xcaf_document,
    stabilize_step_presentation,
)


_CLEARANCE_MM = 0.8
_MIN_SPAN_MM = 0.25
_SPLINE_TOLERANCE_MM = 0.001
_WIRE_GAP_MM = 0.15
_RED_BLACK = ("#cc2929", "#222428")
_DEFAULT_COLORS = {
    "dc_power": _RED_BLACK,
    "brushless_phase": (*_RED_BLACK, "#d99b26"),
    "ttl_serial": (*_RED_BLACK, "#e5c158"),
    "pwm_signal": (*_RED_BLACK, "#3b82f6"),
    "i2c_spi_uart": (*_RED_BLACK, "#3b82f6"),
}


def _unit(vector: np.ndarray) -> np.ndarray:
    length = np.linalg.norm(vector)
    if not np.isfinite(length) or length < 1e-12:
        raise RuntimeError("Cable routing requires a finite, nonzero direction")
    return vector / length


def _route_endpoint(
    nodes: dict[str, dict[str, Any]], relationship: dict[str, Any], end: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    component_id = relationship.get(f"{end}ComponentId")
    port_id = relationship.get(f"{end}PortId")
    node = nodes.get(component_id)
    if not port_id:
        raise RuntimeError(f"Electrical relationship {relationship['id']} is missing {end}PortId")
    if node is not None:
        for port in node.get("ports", []):
            if port["portId"] == port_id:
                return node, port
    raise RuntimeError(
        f"Electrical relationship {relationship['id']} has {end}PortId {port_id!r} "
        f"with no matching port on component {component_id!r}"
    )


def _route_points(
    start: np.ndarray, end: np.ndarray, start_exit: np.ndarray, end_exit: np.ndarray,
    waypoints: list[np.ndarray],
) -> list[np.ndarray]:
    lead_out_mm = min(8.0, 0.25 * np.linalg.norm(end - start))
    start = start + _CLEARANCE_MM * start_exit
    end = end + _CLEARANCE_MM * end_exit
    points = [start]
    for point in [start + start_exit * lead_out_mm, *waypoints, end + end_exit * lead_out_mm]:
        if np.linalg.norm(point - points[-1]) >= _MIN_SPAN_MM:
            points.append(point)
    if len(points) > 1 and np.linalg.norm(end - points[-1]) < _MIN_SPAN_MM:
        points.pop()
    if np.linalg.norm(end - points[-1]) < _MIN_SPAN_MM:
        raise RuntimeError("Cable endpoints are too close to route")
    return [*points, end]


def _ribbon_axes(
    points: list[np.ndarray], start_exit: np.ndarray, end_exit: np.ndarray
) -> list[np.ndarray]:
    up = np.array([0.0, 0.0, 1.0])
    lateral = np.cross(start_exit, up)
    if np.linalg.norm(lateral) < 0.1:
        lateral = np.cross(start_exit, [1.0, 0.0, 0.0])
    lateral = _unit(lateral)
    segments = [_unit(after - before) for before, after in zip(points, points[1:])]
    tangents = [
        start_exit,
        *(_unit(before + after) for before, after in zip(segments, segments[1:])),
        -end_exit,
    ]
    axes = [lateral]
    for previous, tangent in zip(tangents, tangents[1:]):
        cross = np.cross(previous, tangent)
        dot = np.dot(previous, tangent)
        if dot > -1 + 1e-9:
            tangent_rotation = np.cross(cross, lateral)
            lateral = lateral + tangent_rotation + np.cross(cross, tangent_rotation) / (1 + dot)
        lateral = _unit(lateral - tangent * np.dot(tangent, lateral))
        axes.append(lateral)
    return axes


def _spline(
    points: list[np.ndarray], start_exit: np.ndarray, end_exit: np.ndarray,
    parameters: HArray1_double | None = None,
) -> Geom_BSplineCurve:
    array = Array1_gp_Pnt(1, len(points))
    for index, point in enumerate(points, start=1):
        array.SetValue(index, gp_Pnt(*point))
    if parameters is None:
        approximation = GeomAPI_PointsToBSpline(array, 3, 8, Tol3D=_SPLINE_TOLERANCE_MM)
        if approximation.IsDone():
            curve = approximation.Curve()
            start_tangent = gp_Dir(curve.DN(curve.FirstParameter(), 1))
            end_tangent = gp_Dir(curve.DN(curve.LastParameter(), 1))
            if start_tangent.IsEqual(gp_Dir(*start_exit), 1e-4) and end_tangent.IsEqual(gp_Dir(*-end_exit), 1e-4):
                return curve
        interpolation = GeomAPI_Interpolate(HArray1_gp_Pnt(array), False, 1e-7)
    else:
        interpolation = GeomAPI_Interpolate(HArray1_gp_Pnt(array), parameters, False, 1e-7)
    interpolation.Load(gp_Vec(*start_exit), gp_Vec(*-end_exit), parameters is None)
    interpolation.Perform()
    if not interpolation.IsDone():
        raise RuntimeError("Could not interpolate the cable centerline")
    return interpolation.Curve()


def _sweep_conductor(curve: Geom_BSplineCurve, radius_mm: float) -> tuple[TopoDS_Wire, TopoDS_Shape]:
    route = BRepBuilderAPI_MakeWire()
    for knot in range(1, curve.NbKnots()):
        span = curve.Copy()
        span.Segment(curve.Knot(knot), curve.Knot(knot + 1))
        route.Add(BRepBuilderAPI_MakeEdge(span).Edge())
    spine = route.Wire()
    start_parameter = curve.FirstParameter()
    tangent = gp_Dir(curve.DN(start_parameter, 1))
    profile = gp_Circ(gp_Ax2(curve.Value(start_parameter), tangent), radius_mm)
    section = BRepBuilderAPI_MakeWire(
        BRepBuilderAPI_MakeEdge(profile, 0.0, pi).Edge(),
        BRepBuilderAPI_MakeEdge(profile, pi, 2 * pi).Edge(),
    ).Wire()
    sweep = BRepOffsetAPI_MakePipeShell(spine)
    sweep.SetMode(True)
    sweep.SetTransitionMode(BRepBuilderAPI_RoundCorner)
    sweep.Add(section)
    sweep.Build()
    if not sweep.IsDone() or not sweep.MakeSolid():
        raise RuntimeError("Could not sweep a solid cable conductor")
    solid = sweep.Shape()
    if not BRepCheck_Analyzer(solid).IsValid() or count_brep_faces(solid) < MIN_CAD_BREP_FACES:
        raise RuntimeError("Cable conductor sweep produced an invalid BRep")
    return spine, solid


def _validate_conductor_clearance(
    conductors: list[tuple[TopoDS_Wire, TopoDS_Shape]], diameter_mm: float
) -> None:
    for (first_wire, first_solid), (second_wire, second_solid) in combinations(conductors, 2):
        distance = BRepExtrema_DistShapeShape(first_wire, second_wire)
        if distance.IsDone() and distance.Value() > diameter_mm + _SPLINE_TOLERANCE_MM:
            continue
        common = BRepAlgoAPI_Common(first_solid, second_solid)
        if not common.IsDone():
            raise RuntimeError("Could not validate cable conductor clearance")
        properties = GProp_GProps()
        BRepGProp.VolumeProperties_s(common.Shape(), properties)
        if properties.Mass() > 1e-6:
            raise RuntimeError("Cable routing produces overlapping conductors")


def write_colored_step(
    step_path: Path,
    components: list[tuple[str, TopoDS_Shape, tuple[str, ...]]],
    styled_steps: dict[str, tuple[Path, gp_Trsf | tuple[float, float, float]]] | None = None,
) -> None:
    document = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    color_tool = XCAFDoc_DocumentTool.ColorTool_s(document.Main())
    assembly = shape_tool.NewShape()
    TDataStd_Name.Set_s(assembly, TCollection_ExtendedString("Zappd Assembly"))
    styled_steps = styled_steps or {}
    for cid, shape, colors in components:
        if cid in styled_steps:
            fixture, placement = styled_steps[cid]
            source = read_xcaf_document(fixture)
            roots = Sequence_TDF_Label()
            XCAFDoc_DocumentTool.ShapeTool_s(source.Main()).GetFreeShapes(roots)
            label = shape_tool.NewShape()
            if not XCAFDoc_Editor.Extract_s(roots, label):
                raise RuntimeError(f"Could not transfer STEP styles for {cid}")
            TDataStd_Name.Set_s(label, TCollection_ExtendedString(cid))
            if isinstance(placement, gp_Trsf):
                transform = placement
            else:
                transform = gp_Trsf()
                transform.SetTranslation(gp_Vec(*placement))
            shape_tool.AddComponent(assembly, label, TopLoc_Location(transform))
            continue
        if not colors:
            label = shape_tool.AddShape(shape, False)
            TDataStd_Name.Set_s(label, TCollection_ExtendedString(cid))
            shape_tool.AddComponent(assembly, label, TopLoc_Location())
            continue

        cable = assembly if len(components) == 1 else shape_tool.NewShape()
        TDataStd_Name.Set_s(cable, TCollection_ExtendedString(cid))
        children = TopoDS_Iterator(shape)
        for index, color_hex in enumerate(colors, start=1):
            conductor = children.Value()
            children.Next()
            label = shape_tool.AddShape(conductor, False)
            TDataStd_Name.Set_s(label, TCollection_ExtendedString(f"{cid}_wire_{index}"))
            rgb = [int(color_hex[index:index + 2], 16) / 255 for index in (1, 3, 5)]
            color_tool.SetColor(label, Quantity_Color(*rgb, Quantity_TOC_sRGB), XCAFDoc_ColorGen)
            shape_tool.AddComponent(cable, label, TopLoc_Location())
        if len(components) > 1:
            shape_tool.AddComponent(assembly, cable, TopLoc_Location())

    shape_tool.UpdateAssemblies()
    writer = STEPCAFControl_Writer()
    if not writer.Transfer(document, STEPControl_AsIs):
        raise RuntimeError(f"Could not transfer colored STEP assembly for {step_path.name}")
    model = writer.ChangeWriter().Model()
    header = APIHeaderSection_MakeHeader(model)
    header.SetTimeStamp(TCollection_HAsciiString("2026-01-01T00:00:00"))
    occurrence_id = 0
    for index in range(1, model.NbEntities() + 1):
        entity = model.Value(index)
        if isinstance(entity, StepRepr_NextAssemblyUsageOccurrence):
            occurrence_id += 1
            entity.SetId(TCollection_HAsciiString(str(occurrence_id)))
    if writer.Write(str(step_path)) != IFSelect_RetDone:
        raise RuntimeError(f"Could not write colored STEP file {step_path}")
    if styled_steps or any(colors for _, _, colors in components):
        stabilize_step_presentation(step_path)


def _sweep_bundle(
    points: list[np.ndarray], start_exit: np.ndarray, end_exit: np.ndarray, wire_count: int, diameter_mm: float,
) -> TopoDS_Compound:
    if wire_count == 1:
        conductors = [_sweep_conductor(_spline(points, start_exit, end_exit), diameter_mm / 2)]
    else:
        axes = _ribbon_axes(points, start_exit, end_exit)
        parameters = HArray1_double(1, len(points))
        parameters.SetValue(1, 0.0)
        for index, (before, after) in enumerate(zip(points, points[1:]), start=2):
            parameters.SetValue(index, parameters.Value(index - 1) + np.linalg.norm(after - before))
        conductors = []
        for index in range(wire_count):
            offset = (index - (wire_count - 1) / 2) * (diameter_mm + _WIRE_GAP_MM)
            wire_points = [point + offset * axis for point, axis in zip(points, axes)]
            curve = _spline(wire_points, start_exit, end_exit, parameters)
            conductors.append(_sweep_conductor(curve, diameter_mm / 2))
        _validate_conductor_clearance(conductors, diameter_mm)

    compound = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(compound)
    for _, solid in conductors:
        builder.Add(compound, solid)

    return compound
def _rounded_bundle(
    points: list[np.ndarray], start_exit: np.ndarray, wire_count: int, diameter_mm: float,
) -> TopoDS_Compound:
    radius = (diameter_mm + (wire_count - 1) * (diameter_mm + _WIRE_GAP_MM)) / 2
    route = BRepBuilderAPI_MakeWire()
    cursor = points[0]
    for before, corner, after in zip(points, points[1:], points[2:]):
        incoming, outgoing = _unit(corner - before), _unit(after - corner)
        dot = float(np.clip(np.dot(incoming, outgoing), -1, 1))
        if dot > 1 - 1e-7:
            continue
        if dot < -1 + 1e-7:
            raise RuntimeError("Cable route doubles back at a corner")
        half_turn = tan(acos(dot) / 2)
        span = min(5.0 * half_turn, np.linalg.norm(corner - before) * 0.48,
                   np.linalg.norm(after - corner) * 0.48)
        if span / half_turn <= radius + _SPLINE_TOLERANCE_MM:
            raise RuntimeError("Cable bend radius is too small for the conductor bundle")
        first, last = corner - incoming * span, corner + outgoing * span
        route.Add(BRepBuilderAPI_MakeEdge(gp_Pnt(*cursor), gp_Pnt(*first)).Edge())
        arc = GC_MakeArcOfCircle(gp_Pnt(*first), gp_Vec(*incoming), gp_Pnt(*last))
        route.Add(BRepBuilderAPI_MakeEdge(arc.Value()).Edge())
        cursor = last
    route.Add(BRepBuilderAPI_MakeEdge(gp_Pnt(*cursor), gp_Pnt(*points[-1])).Edge())
    spine = route.Wire()

    lateral = np.cross(start_exit, [0, 0, 1])
    if np.linalg.norm(lateral) < 0.1:
        lateral = np.cross(start_exit, [1, 0, 0])
    lateral = _unit(lateral)
    builder = BRep_Builder()
    bundle = TopoDS_Compound()
    builder.MakeCompound(bundle)
    for index in range(wire_count):
        offset = (index - (wire_count - 1) / 2) * (diameter_mm + _WIRE_GAP_MM)
        center = points[0] + offset * lateral
        profile = gp_Circ(gp_Ax2(gp_Pnt(*center), gp_Dir(*start_exit)), diameter_mm / 2)
        section = BRepBuilderAPI_MakeWire(
            BRepBuilderAPI_MakeEdge(profile, 0.0, pi).Edge(),
            BRepBuilderAPI_MakeEdge(profile, pi, 2 * pi).Edge(),
        ).Wire()
        swept = BRepOffsetAPI_MakePipeShell(spine)
        swept.SetMode(False)
        swept.Add(section)
        swept.Build()
        if not swept.IsDone() or not swept.MakeSolid():
            raise RuntimeError("Could not sweep the rounded cable route")
        solid = swept.Shape()
        if not BRepCheck_Analyzer(solid).IsValid() or count_brep_faces(solid) < MIN_CAD_BREP_FACES:
            raise RuntimeError("Rounded cable conductor produced an invalid BRep")
        children = TopoDS_Iterator(bundle)
        while children.More():
            common = BRepAlgoAPI_Common(solid, children.Value())
            properties = GProp_GProps()
            if not common.IsDone():
                raise RuntimeError("Could not validate rounded cable conductor clearance")
            BRepGProp.VolumeProperties_s(common.Shape(), properties)
            if properties.Mass() > 1e-6:
                raise RuntimeError("Rounded cable bundle has overlapping conductors")
            children.Next()
        builder.Add(bundle, solid)
    return bundle
def _auto_route_bundle(
    relationship_id: str, start: np.ndarray, end: np.ndarray, start_exit: np.ndarray, end_exit: np.ndarray,
    start_id: str, end_id: str, wire_count: int, diameter_mm: float,
    obstacles: dict[str, TopoDS_Shape], repair_attempt: int, harness_ids: set[str],
) -> TopoDS_Compound:
    from geometry_pipeline import interference_volume_mm3, shape_bounds_mm

    blocked = f"Cable routing blocked: no collision-free path for {relationship_id}"
    radius = diameter_mm / 2 + (wire_count - 1) / 2 * (diameter_mm + _WIRE_GAP_MM)
    space = RoutingSpace(routing_boxes(obstacles, {start_id, end_id}, harness_ids), radius + 0.25 + repair_attempt * 0.35)
    first = escape_port(space, start, start_exit, start_id, _CLEARANCE_MM)
    last = escape_port(space, end, end_exit, end_id, _CLEARANCE_MM)
    if first is None or last is None:
        raise CableRoutingBlockedError(f"{blocked}: obstructed port exit")

    obstacle_bounds = {cid: shape_bounds_mm(shape) for cid, shape in obstacles.items()}
    last_failure = "no free channel or voxel detour"

    def sweep(path: list[np.ndarray]) -> TopoDS_Compound | None:
        nonlocal last_failure
        if len(path) > 5 or any(not space.clear(a, b) for a, b in zip(path, path[1:])):
            return None
        points = [first[0]]
        for point in [*path, last[0]]:
            if np.linalg.norm(point - points[-1]) >= _MIN_SPAN_MM:
                points.append(point)
        if len(points) < 3:
            return None
        try:
            bundle = _rounded_bundle(points, start_exit, wire_count, diameter_mm)
        except RuntimeError as error:
            last_failure = str(error)
            return None
        bounds = shape_bounds_mm(bundle)
        for cid, obstacle in obstacles.items():
            if bounds_distance_mm(bounds, obstacle_bounds[cid]) > 0:
                continue
            volume = interference_volume_mm3(bundle, obstacle)
            if volume > INTERFERENCE_TOLERANCE_MM3:
                last_failure = f"swept cable intersects {cid}: {volume:.4f} mm^3"
                return None
        return bundle

    for channel in channel_paths(space, first[1], last[1]):
        bundle = sweep(channel)
        if bundle is not None:
            return bundle

    detour = voxel_path(space, first[1], last[1], (4, 3.25, 2.5)[repair_attempt])
    if detour is not None:
        bundle = sweep(detour)
        if bundle is not None:
            return bundle

    raise CableRoutingBlockedError(f"{blocked}: {last_failure}")


class CableRoutingBlockedError(RuntimeError):
    pass


def route_harness_for_node(
    node_spec: dict[str, Any], archetype_spec: dict[str, Any], cache_dir: Path,
    obstacles: dict[str, TopoDS_Shape] | None = None, *, auto_route: bool = False, repair_attempt: int = 0,
    harness_ids: set[str] | None = None,
) -> dict[str, Any]:
    from geometry_pipeline import shape_bounds_mm, translate_shape_mm

    policy = GEOMETRY_ORIGIN_POLICY["procedural_harness"]
    provenance_failure = node_provenance_failure(node_spec, policy)
    if provenance_failure is not None:
        raise RuntimeError(provenance_failure)

    relationship_id = node_spec.get("specifications", {}).get("relationshipId")
    relationship = next(
        (item for item in archetype_spec.get("relationships", []) if item["id"] == relationship_id),
        None,
    )
    if relationship is None:
        raise RuntimeError(f"Harness {node_spec['id']} has no matching electrical relationship {relationship_id!r}")
    if relationship.get("connectionType") not in {"electrical_bus", "power_bus"}:
        raise RuntimeError(f"Harness {node_spec['id']} requires an electrical relationship, got {relationship_id!r}")

    nodes = {node["id"]: node for node in archetype_spec["nodes"]}
    from_node, from_port = _route_endpoint(nodes, relationship, "from")
    to_node, to_port = _route_endpoint(nodes, relationship, "to")

    def endpoint(node: dict[str, Any], port: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
        rotation = world_rotation(node.get("restRotationDeg", (0, 0, 0)))
        world = np.asarray(node["restPositionMeters"]) + rotate_vector(rotation, port["localPositionMeters"])
        exit_direction = rotate_vector(rotation, port["exitDirection"])
        return np.asarray(world_rest_to_cad_mm(world)), _unit(np.asarray(world_rest_to_cad_mm(exit_direction)))

    start, start_exit = endpoint(from_node, from_port)
    end, end_exit = endpoint(to_node, to_port)
    waypoints = [
        np.asarray(world_rest_to_cad_mm(point)) for point in relationship.get("routingWaypointsMeters", [])
    ]
    colors = tuple(
        from_port.get("wireColorsHex") or to_port.get("wireColorsHex")
        or _DEFAULT_COLORS.get(from_port["busKind"], (node_spec["colorHex"],))
    )
    bundle_mm = relationship.get("wireBundleDiameterMm", 1.8)
    diameter_mm = (
        min(3.2, max(1.8, bundle_mm)) if len(colors) == 1
        else min(2.2, max(0.9, bundle_mm / (len(colors) * 0.85)))
    )

    if relationship.get("routingStyle") == "filleted_polyline" and not auto_route:
        points = [start, *waypoints, end]
        for endpoint, adjacent, field in (
            (0, 1, "fromConnectorClearanceMm"),
            (-1, -2, "toConnectorClearanceMm"),
        ):
            clearance = node_spec["specifications"].get(field, 0)
            if clearance:
                lead = points[adjacent] - points[endpoint]
                if not 0 < clearance < np.linalg.norm(lead) - _MIN_SPAN_MM:
                    raise RuntimeError(f"Harness {node_spec['id']} has invalid {field}")
                points[endpoint] = points[endpoint] + clearance * _unit(lead)
        compound = _rounded_bundle(points, _unit(points[1] - points[0]), len(colors), diameter_mm)
    elif waypoints and not auto_route:
        points = _route_points(start, end, start_exit, end_exit, waypoints)
        compound = _sweep_bundle(points, start_exit, end_exit, len(colors), diameter_mm)
    else:
        compound = _auto_route_bundle(
            relationship["id"], start, end, start_exit, end_exit, from_node["id"], to_node["id"],
            len(colors), diameter_mm, obstacles or {}, repair_attempt, harness_ids or set(),
        )

    lower, upper = shape_bounds_mm(compound)
    x, y, z = ((lo + hi) / 2 for lo, hi in zip(lower, upper))
    centered = translate_shape_mm(compound, (-x, -y, -z))
    step_path = cache_dir / node_spec["stepFixtureName"]
    step_path.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=step_path.parent) as staging:
        staged_step = Path(staging) / step_path.name
        write_colored_step(staged_step, [(node_spec["id"], centered, colors)])
        sha = read_step_digest(staged_step, node_spec.get("expectedStepSha256"))
        face_count = count_brep_faces(centered)
        staged_step.replace(step_path)

    return {
        "hasGeometry": True,
        "shape": centered,
        "stepPath": step_path,
        "sha256": sha,
        "faceCount": face_count,
        "restPositionMeters": [x / 1000, z / 1000, -y / 1000],
        "dimensionsMm": [upper[axis] - lower[axis] for axis in (0, 2, 1)],
        "targetVerifiedStatus": policy["targetVerifiedStatus"],
        "provenanceFailure": provenance_failure,
        "conductorColors": colors,
    }
