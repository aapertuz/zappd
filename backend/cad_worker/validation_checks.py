from __future__ import annotations

from itertools import combinations
from math import dist

from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.TopoDS import TopoDS_Shape

CONNECTIVITY_TOLERANCE_MM = 4.3
INTERFERENCE_TOLERANCE_MM3 = 1e-3


def bounds_distance_mm(first, second) -> float:
    return dist((0, 0, 0), tuple(
        max(0, low_a - high_b, low_b - high_a)
        for low_a, high_a, low_b, high_b in zip(*first, *second)
    ))


def floating_components(
    solids: dict[str, TopoDS_Shape], bounds: dict, tolerance_mm: float = CONNECTIVITY_TOLERANCE_MM,
) -> list[str]:
    groups = {cid: {cid} for cid in solids}
    candidates = sorted(
        (bounds_distance_mm(bounds[first], bounds[second]), first, second)
        for first, second in combinations(solids, 2)
    )
    for lower_bound, first, second in candidates:
        if lower_bound > tolerance_mm:
            break
        if groups[first] is groups[second]:
            continue
        distance = BRepExtrema_DistShapeShape(solids[first], solids[second])
        if not distance.IsDone():
            raise RuntimeError(f"Could not measure BRep connectivity between {first} and {second}")
        if distance.Value() <= tolerance_mm:
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
        first = by_id.get(relationship["fromComponentId"], {})
        second = by_id.get(relationship["toComponentId"], {})
        if not first.get("ports") or not second.get("ports"):
            continue
        first_id, second_id = relationship.get("fromPortId"), relationship.get("toPortId")
        port_a, port_b = _declared_port(first, first_id), _declared_port(second, second_id)
        if port_a is None or port_b is None:
            failures.append(f"{relationship['id']}: electrical endpoints reference missing ports {first_id!r}, {second_id!r}")
            continue
        failures.extend(f"{relationship['id']}: {failure}" for failure in _port_failures(port_a, port_b))
    return failures
