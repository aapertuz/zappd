from __future__ import annotations

from itertools import combinations
from math import dist

import numpy as np
from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Tool
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.Extrema import Extrema_ExtFlag_MIN
from OCP.TopAbs import TopAbs_FACE, TopAbs_IN, TopAbs_SOLID, TopAbs_VERTEX
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Shape
from OCP.gp import gp_Pnt

CONNECTIVITY_TOLERANCE_MM = 4.3
INTERFERENCE_TOLERANCE_MM3 = 1e-3
_BOX_OVERLAP_EPS_MM = 1e-4
_CLASSIFIER_TOL_MM = 1e-5

FaceBoxes = tuple[list[TopoDS_Shape], np.ndarray, np.ndarray]
SolidProbe = tuple[tuple[float, float, float], tuple[float, float, float], gp_Pnt | None]


def bounds_distance_mm(first, second) -> float:
    return dist((0, 0, 0), tuple(
        max(0, low_a - high_b, low_b - high_a)
        for low_a, high_a, low_b, high_b in zip(*first, *second)
    ))


def extract_face_boxes(shape: TopoDS_Shape) -> FaceBoxes:
    faces: list[TopoDS_Shape] = []
    mins: list[tuple[float, float, float]] = []
    maxs: list[tuple[float, float, float]] = []
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = explorer.Current()
        box = Bnd_Box()
        BRepBndLib.Add_s(face, box)
        cmin, cmax = box.CornerMin(), box.CornerMax()
        faces.append(face)
        mins.append((cmin.X(), cmin.Y(), cmin.Z()))
        maxs.append((cmax.X(), cmax.Y(), cmax.Z()))
        explorer.Next()
    if not faces:
        return faces, np.empty((0, 3)), np.empty((0, 3))
    return faces, np.asarray(mins, dtype=np.float64), np.asarray(maxs, dtype=np.float64)


def extract_solid_probes(shape: TopoDS_Shape) -> list[SolidProbe]:
    probes: list[SolidProbe] = []
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        solid = explorer.Current()
        box = Bnd_Box()
        BRepBndLib.Add_s(solid, box)
        cmin, cmax = box.CornerMin(), box.CornerMax()
        vertex_explorer = TopExp_Explorer(solid, TopAbs_VERTEX)
        sample = BRep_Tool.Pnt_s(TopoDS.Vertex(vertex_explorer.Current())) if vertex_explorer.More() else None
        probes.append((
            (cmin.X(), cmin.Y(), cmin.Z()),
            (cmax.X(), cmax.Y(), cmax.Z()),
            sample,
        ))
        explorer.Next()
    return probes


def _has_face_box_overlap(
    first_boxes: FaceBoxes,
    second_boxes: FaceBoxes,
    first_bounds,
    second_bounds,
) -> bool:
    faces_a, mins_a, maxs_a = first_boxes
    faces_b, mins_b, maxs_b = second_boxes
    if not faces_a or not faces_b:
        return False
    b_low = np.asarray(second_bounds[0], dtype=np.float64) - _BOX_OVERLAP_EPS_MM
    b_high = np.asarray(second_bounds[1], dtype=np.float64) + _BOX_OVERLAP_EPS_MM
    idx_a = np.nonzero(np.all((maxs_a >= b_low) & (mins_a <= b_high), axis=1))[0]
    if len(idx_a) == 0:
        return False
    a_low = np.asarray(first_bounds[0], dtype=np.float64) - _BOX_OVERLAP_EPS_MM
    a_high = np.asarray(first_bounds[1], dtype=np.float64) + _BOX_OVERLAP_EPS_MM
    idx_b = np.nonzero(np.all((maxs_b >= a_low) & (mins_b <= a_high), axis=1))[0]
    if len(idx_b) == 0:
        return False
    mins_sub_a, maxs_sub_a = mins_a[idx_a], maxs_a[idx_a]
    mins_sub_b, maxs_sub_b = mins_b[idx_b], maxs_b[idx_b]
    for local_i in range(len(idx_a)):
        if np.any(
            np.all(
                (maxs_sub_a[local_i] >= mins_sub_b - _BOX_OVERLAP_EPS_MM)
                & (mins_sub_a[local_i] <= maxs_sub_b + _BOX_OVERLAP_EPS_MM),
                axis=1,
            )
        ):
            return True
    return False


def _box_contained(inner_low, inner_high, outer_low, outer_high) -> bool:
    return all(
        inner_low[axis] >= outer_low[axis] - _BOX_OVERLAP_EPS_MM
        and inner_high[axis] <= outer_high[axis] + _BOX_OVERLAP_EPS_MM
        for axis in range(3)
    )


def _probe_strictly_inside(
    target_id: str,
    target_shape: TopoDS_Shape,
    target_bounds,
    probes: list[SolidProbe],
    classifiers: dict[str, BRepClass3d_SolidClassifier],
) -> bool:
    for probe_low, probe_high, sample_point in probes:
        if not _box_contained(probe_low, probe_high, target_bounds[0], target_bounds[1]):
            continue
        if sample_point is None:
            return True
        classifier = classifiers.get(target_id)
        if classifier is None:
            classifier = BRepClass3d_SolidClassifier(target_shape)
            classifiers[target_id] = classifier
        classifier.Perform(sample_point, _CLASSIFIER_TOL_MM)
        if classifier.State() == TopAbs_IN:
            return True
    return False


def solids_may_intersect(
    id_a: str,
    id_b: str,
    shape_a: TopoDS_Shape,
    shape_b: TopoDS_Shape,
    face_boxes_a: FaceBoxes,
    face_boxes_b: FaceBoxes,
    bounds_a,
    bounds_b,
    probes_a: list[SolidProbe],
    probes_b: list[SolidProbe],
    classifiers: dict[str, BRepClass3d_SolidClassifier],
) -> bool:
    if _has_face_box_overlap(face_boxes_a, face_boxes_b, bounds_a, bounds_b):
        return True
    return _probe_strictly_inside(id_b, shape_b, bounds_b, probes_a, classifiers) or _probe_strictly_inside(
        id_a, shape_a, bounds_a, probes_b, classifiers
    )


def _shapes_within_tolerance(
    first: str,
    second: str,
    first_boxes: tuple[list[TopoDS_Shape], np.ndarray, np.ndarray],
    second_boxes: tuple[list[TopoDS_Shape], np.ndarray, np.ndarray],
    first_bounds,
    second_bounds,
    tolerance_mm: float,
) -> bool:
    faces_a, mins_a, maxs_a = first_boxes
    faces_b, mins_b, maxs_b = second_boxes
    if not faces_a or not faces_b:
        return False
    b_low = np.asarray(second_bounds[0], dtype=np.float64) - tolerance_mm
    b_high = np.asarray(second_bounds[1], dtype=np.float64) + tolerance_mm
    idx_a = np.nonzero(np.all((maxs_a >= b_low) & (mins_a <= b_high), axis=1))[0]
    if len(idx_a) == 0:
        return False
    a_low = np.asarray(first_bounds[0], dtype=np.float64) - tolerance_mm
    a_high = np.asarray(first_bounds[1], dtype=np.float64) + tolerance_mm
    idx_b = np.nonzero(np.all((maxs_b >= a_low) & (mins_b <= a_high), axis=1))[0]
    if len(idx_b) == 0:
        return False

    mins_sub_a, maxs_sub_a = mins_a[idx_a], maxs_a[idx_a]
    mins_sub_b, maxs_sub_b = mins_b[idx_b], maxs_b[idx_b]
    tolerance_sq = tolerance_mm * tolerance_mm
    candidate_pairs: list[tuple[float, int, int]] = []
    for local_i, face_a_idx in enumerate(idx_a):
        delta = np.maximum(
            0.0,
            np.maximum(mins_sub_a[local_i] - maxs_sub_b, mins_sub_b - maxs_sub_a[local_i]),
        )
        dist_sq = np.sum(delta * delta, axis=1)
        for local_j in np.nonzero(dist_sq <= tolerance_sq)[0]:
            candidate_pairs.append((float(dist_sq[local_j]), int(face_a_idx), int(idx_b[local_j])))
    candidate_pairs.sort()
    for _, face_a_idx, face_b_idx in candidate_pairs:
        distance = BRepExtrema_DistShapeShape(
            faces_a[face_a_idx], faces_b[face_b_idx], Extrema_ExtFlag_MIN,
        )
        if not distance.IsDone():
            raise RuntimeError(f"Could not measure BRep connectivity between {first} and {second}")
        if distance.Value() <= tolerance_mm:
            return True
    return False


def floating_components(
    solids: dict[str, TopoDS_Shape],
    bounds: dict,
    tolerance_mm: float = CONNECTIVITY_TOLERANCE_MM,
    face_boxes: dict[str, FaceBoxes] | None = None,
) -> list[str]:
    boxes = face_boxes if face_boxes is not None else {cid: extract_face_boxes(shape) for cid, shape in solids.items()}
    groups = {cid: {cid} for cid in solids}
    candidates = sorted(
        (
            bounds_distance_mm(bounds[first], bounds[second]),
            len(boxes[first][0]) * len(boxes[second][0]),
            first,
            second,
        )
        for first, second in combinations(solids, 2)
    )
    for lower_bound, _, first, second in candidates:
        if lower_bound > tolerance_mm:
            break
        if groups[first] is groups[second]:
            continue
        if _shapes_within_tolerance(
            first, second, boxes[first], boxes[second], bounds[first], bounds[second], tolerance_mm,
        ):
            group = groups[first] | groups[second]
            for cid in group:
                groups[cid] = group
            if len(group) == len(solids):
                return []
    anchored = max(groups.values(), key=len, default=set())
    return [cid for cid in solids if cid not in anchored]


def _declared_port(node: dict, port_id: str | None) -> dict | None:
    return next((port for port in node.get("ports", ()) if port["portId"] == port_id), None)


def _port_failures(first: dict, second: dict) -> list[str]:
    failures = []
    kind_a, kind_b = first["busKind"], second["busKind"]
    if (
        kind_a != kind_b
        and kind_a not in second.get("compatibleBusKinds", ())
        and kind_b not in first.get("compatibleBusKinds", ())
    ):
        failures.append(f"incompatible bus kinds {kind_a} and {kind_b}")

    role_a, role_b = first.get("role"), second.get("role")
    if role_a == role_b and role_a in {"source", "sink"}:
        failures.append(f"incompatible port roles {role_a} and {role_b}")
    source, sink = (first, second) if role_a == "source" else (second, first)
    directed = {role_a, role_b} == {"source", "sink"}

    voltage_fields = ("minVoltageV", "maxVoltageV", "nominalVoltageV")
    if all(field in port for field in voltage_fields for port in (first, second)):
        if max(first["minVoltageV"], second["minVoltageV"]) > min(first["maxVoltageV"], second["maxVoltageV"]):
            failures.append("voltage operating ranges do not overlap")
        source_to_sink = "source" in {role_a, role_b} and ({role_a, role_b} & {"sink", "bidirectional"})
        if source_to_sink and not sink["minVoltageV"] <= source["nominalVoltageV"] <= sink["maxVoltageV"]:
            failures.append(
                f"source nominal voltage {source['nominalVoltageV']} V is outside "
                f"sink range {sink['minVoltageV']}–{sink['maxVoltageV']} V"
            )
    if directed and "maxCurrentA" in source and "maxCurrentA" in sink:
        if source["maxCurrentA"] < sink["maxCurrentA"]:
            failures.append(
                f"source current {source['maxCurrentA']} A is below sink requirement {sink['maxCurrentA']} A"
            )
    return failures


def electrical_failures(nodes: list[dict], relationships: list[dict]) -> list[str]:
    by_id = {node["id"]: node for node in nodes}
    failures = []
    for relationship in relationships:
        if relationship.get("connectionType") not in {"power_bus", "electrical_bus"}:
            continue
        first = by_id.get(relationship["fromComponentId"])
        second = by_id.get(relationship["toComponentId"])
        first_id, second_id = relationship.get("fromPortId"), relationship.get("toPortId")
        if first_id is None and second_id is None:
            continue
        if first is None or second is None:
            failures.append(
                f"{relationship['id']}: electrical endpoints reference missing components "
                f"{relationship['fromComponentId']!r}, {relationship['toComponentId']!r}"
            )
            continue
        port_a, port_b = _declared_port(first, first_id), _declared_port(second, second_id)
        if port_a is None or port_b is None:
            failures.append(f"{relationship['id']}: electrical endpoints reference missing ports {first_id!r}, {second_id!r}")
            continue
        failures.extend(f"{relationship['id']}: {failure}" for failure in _port_failures(port_a, port_b))
    return failures
