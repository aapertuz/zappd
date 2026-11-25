from __future__ import annotations

import argparse
import json
from copy import deepcopy
from math import cos, floor, isfinite, radians, sin
from pathlib import Path
from tempfile import TemporaryDirectory

from build123d import Box, Cylinder, Part, Polygon, Pos, chamfer, export_step, extrude

from catalog_ingestor import read_step_digest, stabilize_step_occurrences, validate_step_shape
from catalog_specs import CATALOG_DIR, CATALOG_SPECS
from cots_catalog import get_cots_part

ARCHETYPE_ID = "parametric_multirotor_v1"
_ROOT_ID = "proj_parametric_multirotor"
_SOURCE = f"parametric://zappd/{ARCHETYPE_ID}"
_ALUMINUM = "#566879"
_FRAME_ID = "sub_multi_airframe"
_ROTORS_ID = "sub_multi_rotors"
_ELECTRONICS_ID = "sub_multi_electronics"
_WIRING_ID = "sub_multi_wiring"


def _parameter(name, kind, label, default, minimum, maximum, step, unit) -> dict:
    return {
        "name": name, "kind": kind, "label": label, "defaultValue": default, "value": default,
        "min": minimum, "max": maximum, "step": step, "unit": unit,
    }


PARAMETERS = (
    _parameter("rotor_count", "int", "Rotor Count", 4, 4, 6, 2, "count"),
    _parameter("wheelbase_mm", "float", "Wheelbase", 260, 220, 360, 10, "mm"),
    _parameter("deck_gap_mm", "float", "Deck Gap", 26, 20, 36, 2, "mm"),
    _parameter("arm_thickness_mm", "float", "Arm Thickness", 4, 3, 6, 0.5, "mm"),
)


def parameter_values(parameters: list[dict], overrides: dict[str, float | int]) -> dict[str, float | int]:
    values = {}
    for parameter in parameters:
        name = parameter["name"]
        value = overrides.get(name, parameter["value"])
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not isfinite(value):
            value = parameter["value"]
        minimum, maximum, step = (parameter[key] for key in ("min", "max", "step"))
        offset = min(maximum, max(minimum, value)) - minimum
        snapped = min(maximum, minimum + floor(offset / step + 0.5) * step)
        values[name] = int(snapped) if parameter["kind"] == "int" else float(snapped)
    return values


def _world_position(cad_position) -> list[float]:
    x, y, z = cad_position
    return [round(x / 1000, 12), round(z / 1000, 12), round(-y / 1000, 12)]


def _node(cid: str, name: str, category: str, position: tuple, **fields) -> dict:
    return {
        "id": cid, "parentId": _ROOT_ID, "name": name, "level": "component", "depth": 1,
        "category": category, "colorHex": _ALUMINUM, "dimensionsMm": [1, 1, 1],
        "restPositionMeters": _world_position(position), "explodeDirection": [0, 1, 0],
        "explodeDistanceMeters": 0.04, "materialHint": "anodized_aluminum", "specifications": {},
        "origin": "parametric_cad", "spdxLicense": "MIT", "sourceUrl": f"{_SOURCE}/{cid}",
        "sourceName": "Zappd Multirotor CAD family", "stepFixtureName": None,
        **fields,
    }


def _plate(width: float, height: float, corner: float) -> Part:
    x, y = width / 2, height / 2
    octagon = Polygon(
        (-x + corner, -y), (x - corner, -y), (x, -y + corner), (x, y - corner),
        (x - corner, y), (-x + corner, y), (-x, y - corner), (-x, -y + corner),
    )
    blank = Pos(Z=-1.5) * extrude(octagon, amount=3)
    plate = chamfer(blank.edges(), length=0.35)
    for hx in (-12.0, 12.0):
        for hy in (-12.0, 12.0):
            plate -= Pos(hx, hy) * Cylinder(1.65, 4)
    return plate


def _arm(tip: float, thickness: float) -> Part:
    root = 33.0
    length = tip - root
    beam = Pos(X=-length / 2) * Box(length, 14, thickness)
    flange = Cylinder(17.5, thickness)
    part = beam + flange
    for x in (-6.0, 6.0):
        for y in (-6.0, 6.0):
            part -= Pos(x, y) * Cylinder(1.55, thickness + 1)
    return part


def _step_fields(part: Part, key: str, cache_dir: Path) -> tuple[dict, tuple[float, float, float]]:
    box = part.bounding_box()
    center = tuple(box.center())
    part = part.translate(tuple(-value for value in center))
    fixture = str(Path(ARCHETYPE_ID) / f"{key}.step")
    path = cache_dir / fixture
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=path.parent) as staging:
            staged = Path(staging) / path.name
            if not export_step(part, staged, timestamp="2026-01-01T00:00:00"):
                raise RuntimeError(f"Could not export parametric part {key}")
            stabilized = stabilize_step_occurrences(staged.read_text(encoding="ascii"))
            staged.write_text(stabilized, encoding="ascii")
            staged.replace(path)
    bounds = part.bounding_box()
    return {
        "stepFixtureName": fixture,
        "expectedStepSha256": read_step_digest(path),
        "dimensionsMm": [bounds.size.X, bounds.size.Z, bounds.size.Y],
        "specifications": {"brepFaces": validate_step_shape(part.wrapped, path)},
    }, center


def _source_part(cots_id: str, cid: str, position: tuple, **fields) -> dict:
    source = get_cots_part(cots_id)
    if source is None:
        raise RuntimeError(f"Missing multirotor source part {cots_id}")
    part = deepcopy(source)
    del part["cotsId"], part["tags"]
    dx, dy, dz = part["dimensionsMm"]
    part["dimensionsMm"] = [dx, dz, dy]
    return _node(
        cid, part.pop("name"), part.pop("category"), position,
        **{**part, "parentId": _ELECTRONICS_ID, "depth": 2, **fields},
    )


def materialize_multirotor(template: dict, cache_dir: Path, overrides: dict | None = None) -> dict:
    parameters = deepcopy(template.get("parameters", list(PARAMETERS)))
    values = parameter_values(parameters, overrides or {})
    wiring_dir = Path(ARCHETYPE_ID) / "wiring" / "-".join(f"{value:g}" for value in values.values())
    for item in parameters:
        item["value"] = values[item["name"]]
    rotor_count = int(values["rotor_count"])
    radius = values["wheelbase_mm"] / 2
    gap = values["deck_gap_mm"]
    thickness = values["arm_thickness_mm"]
    top = gap + 3

    nodes = [_node(_ROOT_ID, "Parametric Multirotor", "project", (0, 0, 0),
                  parentId=None, level="project", depth=0,
                  dimensionsMm=[radius * 2 + 112, top + 45, radius * 2 + 112])]
    nodes.extend(
        _node(cid, name, "subsystem", (0, 0, 0), level="subsystem")
        for cid, name in (
            (_FRAME_ID, "Airframe"), (_ROTORS_ID, "Rotor assemblies"),
            (_ELECTRONICS_ID, "Mounted electronics"), (_WIRING_ID, "Cable harnesses"),
        )
    )
    relationships = []
    steps = []

    def relate(first: str, second: str, label: str, kind: str = "assembly_mount", **fields) -> str:
        first_key, second_key = (cid.removeprefix("comp_multi_") for cid in (first, second))
        rid = f"rel_multi_{first_key}_{second_key}"
        relationships.append({
            "id": rid, "fromComponentId": first, "toComponentId": second, "connectionType": kind,
            "howConnected": label,
            "whyConnected": {
                "assembly_mount": "Keeps the parts in their installed positions.",
                "rigid_fastener": "Transfers loads between the mounted parts.",
                "axial_mount": "Transfers rotation from the shaft to the mounted part.",
                "power_bus": "Feeds the downstream electronics from the 3S battery.",
                "electrical_bus": "Carries control, data, or motor phase signals.",
            }[kind],
            **fields,
        })
        return rid

    def step(title: str, components: list[str], relations: list[str]) -> None:
        order = len(steps) + 1
        steps.append({
            "id": f"step_multi_{components[-1].removeprefix('comp_multi_')}", "order": order, "title": title, "summary": f"{title}.",
            "componentIds": components, "relationshipIds": relations,
        })

    def mechanical(cid, label, kind, position, fields, **extra) -> None:
        nodes.append(_node(cid, label, kind, position, **{
            "parentId": _FRAME_ID, "depth": 2, **fields, **extra,
        }))

    lower, _ = _step_fields(_plate(106, 100, 18), "lower_plate", cache_dir)
    upper, _ = _step_fields(_plate(116, 116, 16), "upper_plate", cache_dir)
    post, _ = _step_fields(Cylinder(3.1, gap) - Cylinder(1.55, gap + 1), f"deck_post_bored_{gap:g}", cache_dir)
    arm, arm_center = _step_fields(_arm(radius, thickness), f"arm_{radius:g}_{thickness:g}", cache_dir)

    mechanical("comp_multi_lower", "Lower chassis plate", "chassis", (0, 0, -1.5), lower)
    mechanical("comp_multi_upper", "Upper chassis plate", "chassis", (0, 0, gap + 1.5), upper)
    posts = []
    mounts = [relate("comp_multi_lower", _ROOT_ID, "Locate the chassis at the center of the airframe")]
    for index, (x, y) in enumerate(((-19, -19), (-19, 19), (19, 19), (19, -19)), 1):
        cid = f"comp_multi_deck_post_{index}"
        posts.append(cid)
        mechanical(cid, f"Deck standoff {index}", "standoff", (x, y, gap / 2), post)
        mounts.extend([
            relate(cid, "comp_multi_lower", "Seat the standoff on the lower deck", "rigid_fastener"),
            relate("comp_multi_upper", cid, "Seat the upper deck on the standoff", "rigid_fastener"),
        ])
    step("Assemble the chassis decks", ["comp_multi_lower", *posts, "comp_multi_upper"], mounts)

    reference = {node["id"]: node for node in CATALOG_SPECS["quadcopter_drone_v1"]["nodes"]}
    motor = reference["comp_motor_fl"]
    propeller = reference["subcomp_prop_fl"]
    motors = []
    angles = (135, 45, 315, 225) if rotor_count == 4 else (150, 90, 270, 210, 30, 330)
    for index, angle in enumerate(angles, start=1):
        yaw = radians(angle)
        ux, uy = cos(yaw), sin(yaw)
        motor_x, motor_y = radius * ux, radius * uy
        arm_r = radius + arm_center[0]
        arm_id, motor_id, prop_id = (f"comp_multi_{part}_{index}" for part in ("arm", "motor", "propeller"))
        mechanical(arm_id, f"Arm {index}", "chassis", (arm_r * ux, arm_r * uy, thickness / 2),
                   arm, parentId=_ROTORS_ID, restRotationDeg=[0, angle, 0])
        components = []
        for source, cid, label, z in (
            (motor, motor_id, "Brushless motor", thickness + 17.25),
            (propeller, prop_id, "Dual-blade propeller", thickness + 27),
        ):
            node = {
                **deepcopy(source), "id": cid, "parentId": _ROTORS_ID, "level": "component", "depth": 2,
                "name": f"{label} {index}", "restPositionMeters": _world_position((motor_x, motor_y, z)),
                "restRotationDeg": [0, (angle + 225) % 360, 0],
            }
            components.append(node)
            nodes.append(node)
        phase_port = components[0]["ports"][0]
        phase_port.update(role="sink", minVoltageV=9, nominalVoltageV=11.1, maxVoltageV=12.6, maxCurrentA=2)
        components[0]["specifications"]["configuredPhaseCurrentLimitA"] = 2
        motors.append(motor_id)
        step(f"Install rotor assembly {index}", [arm_id, motor_id, prop_id], [
            relate(arm_id, "comp_multi_lower", "Fasten the arm root to the lower deck", "rigid_fastener"),
            relate(motor_id, arm_id, "Seat the motor on the end pad", "rigid_fastener"),
            relate(prop_id, motor_id, "Mount the propeller on the motor shaft", "axial_mount"),
        ])

    def mount_board(cots_id: str, name: str, x: float, y: float, pcb_bottom: float, yaw: int = 0) -> str:
        cid = f"comp_multi_{name}"
        support_id = f"{cid}_support"
        support, _ = _step_fields(Box(6, 6, 4), "pcb_support", cache_dir)
        mechanical(support_id, f"{name.upper()} standoff", "standoff", (x, y, top + 2), support, parentId=_ELECTRONICS_ID)
        nodes.append(_source_part(cots_id, cid, (x, y, top + 4 - pcb_bottom), restRotationDeg=[0, yaw, 0]))
        step(f"Mount the {name.upper()}", [support_id, cid], [
            relate(support_id, "comp_multi_upper", "Locate the electronics standoff on the upper deck", "rigid_fastener"),
            relate(cid, support_id, "Seat the PCB on its standoff", "rigid_fastener"),
        ])
        return cid

    esc = mount_board("kicad_quad_4in1_esc", "esc", -24, 10, -7.37)
    esc_two = mount_board("kicad_quad_4in1_esc", "esc_aux", 24, 10, -7.37, -90) if rotor_count == 6 else None
    controller = mount_board("kicad_quad_flight_controller", "fc", -2, -31, -2.9)
    receiver = mount_board("kicad_quad_elrs_receiver", "rx", 35, -30, -2.9)

    battery = "comp_multi_battery"
    tray = "comp_multi_battery_cradle"
    cradle, _ = _step_fields(Box(16, 16, 4), "battery_cradle", cache_dir)
    mechanical(tray, "Battery cradle", "battery_mount", (0, 0, -5), cradle, parentId=_ELECTRONICS_ID)
    nodes.append(_source_part("cots_battery_3s_18650", battery, (0, 0, -18.42993927002)))
    step("Mount the battery", [tray, battery], [
        relate(tray, "comp_multi_lower", "Fasten the cradle below the lower deck"),
        relate(battery, tray, "Seat the battery holder against the cradle"),
    ])

    def wire(key: str, first: str, first_port: str, second: str, second_port: str, cargo: str, bus: str) -> None:
        relationship = relate(
            first, second, f"Connect the {cargo.lower()} cable", "power_bus" if bus == "dc_power" else "electrical_bus",
            fromPortId=first_port, toPortId=second_port, wireBundleDiameterMm=1.8,
        )
        cable_id = f"comp_multi_wire_{key}"
        nodes.append(_node(
            cable_id, f"{cargo} harness", "wiring", (0, 0, 0),
            colorHex="#cc2929", materialHint="silicone_wire", origin="procedural_harness",
            sourceUrl=f"harness://zappd/{ARCHETYPE_ID}/{cable_id}",
            stepFixtureName=str(wiring_dir / f"{cable_id}.step"),
            specifications={"relationshipId": relationship}, parentId=_WIRING_ID, depth=2,
        ))
        route_mount = relate(cable_id, first, "Secure the harness near its connector")
        step(f"Install the {cargo.lower()} harness", [cable_id], [relationship, route_mount])

    feed = battery
    if esc_two is not None:
        feed = "comp_multi_power_distribution"
        block, _ = _step_fields(Box(16, 6, 4), "power_distribution", cache_dir)
        ports = []
        for port_id, label, role, x, current in (
            ("port_input", "Battery input", "sink", 0, 15),
            ("port_primary", "Primary ESC output", "source", -5, 7.5),
            ("port_aux", "Auxiliary ESC output", "source", 5, 7.5),
        ):
            ports.append({
                "portId": port_id, "label": label, "connectorType": "Solder pad", "busKind": "dc_power",
                "role": role, "minVoltageV": 9, "nominalVoltageV": 11.1, "maxVoltageV": 12.6,
                "maxCurrentA": current, "localPositionMeters": [x / 1000, 0.002, -0.002 if role == "sink" else 0.002],
                "exitDirection": [0, 1, 0], "wireColorsHex": ["#cc2929", "#222428"],
            })
        mechanical(feed, "ESC power distribution block", "power_distribution", (-46, 39, top + 2),
                   block, ports=ports, parentId=_ELECTRONICS_ID)
        step("Mount the power distribution block", [feed], [
            relate(feed, "comp_multi_upper", "Fasten the distribution block to the upper deck"),
        ])
        wire("main_power", battery, "port_pack_out", feed, "port_input", "Main battery feed", "dc_power")
    for target in (esc, esc_two):
        if target is None:
            continue
        node = next(node for node in nodes if node["id"] == target)
        next(port for port in node["ports"] if port["portId"] == "port_dc_in")["maxCurrentA"] = 7.5
        node["specifications"]["configuredInputCurrentLimitA"] = 7.5
        feed_port = "port_pack_out" if feed == battery else ("port_primary" if target == esc else "port_aux")
        key = "esc_power" if target == esc else "esc_aux_power"
        wire(key, feed, feed_port, target, "port_dc_in", f"{node['name']} battery feed", "dc_power")
    wire("esc_signal", controller, "port_esc", esc, "port_esc", "Flight controller signal", "pwm_signal")
    wire("receiver_data", controller, "port_rx", receiver, "port_rx", "Receiver data", "i2c_spi_uart")
    for index, motor_id in enumerate(motors):
        target = esc if index < 4 else esc_two
        wire(f"motor_{index + 1}", target, f"port_motor_{index % 4 + 1}", motor_id, "port_phase_in",
             f"Motor {index + 1} phase", "brushless_phase")

    return {
        "archetypeId": ARCHETYPE_ID, "title": "Parametric Multirotor",
        "summary": "reconfigurable aircraft with four or six propellers, a dual-deck chassis, and routed electronics",
        "keywords": ["parametric", "hexacopter", "custom drone", "6-rotor", "multirotor"],
        "generationMode": "parametric_family", "rootNodeId": _ROOT_ID, "nodes": nodes,
        "relationships": relationships, "assemblySteps": steps, "parameters": parameters, "parameterValues": values,
    }


def main() -> None:
    from geometry_pipeline import run_cad_pipeline

    parser = argparse.ArgumentParser(description="Regenerate the default multirotor catalog")
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    spec = materialize_multirotor({}, args.cache_dir)
    result = run_cad_pipeline(spec, args.output_dir, args.cache_dir)
    if not result["validation"]["valid"]:
        raise RuntimeError(result["validation"]["failures"])
    generated = {node["id"]: node for node in result["nodes"]}
    for node in spec["nodes"]:
        if node["origin"] == "procedural_harness":
            output = generated[node["id"]]
            for field in ("restPositionMeters", "dimensionsMm", "specifications"):
                node[field] = output[field]
            node["expectedStepSha256"] = output["provenance"]["stepSha256"]
    del spec["parameterValues"]
    (CATALOG_DIR / f"{ARCHETYPE_ID}.json").write_text(json.dumps(spec, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
