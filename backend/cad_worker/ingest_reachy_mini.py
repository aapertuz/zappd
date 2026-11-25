from __future__ import annotations

import argparse
import ast
import hashlib
import json
import math
import operator
import subprocess
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from tempfile import TemporaryDirectory

import build123d as bd
import numpy as np
from OCP.APIHeaderSection import APIHeaderSection_MakeHeader
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.TCollection import TCollection_HAsciiString
from OCP.TDF import TDF_Label
from OCP.TDocStd import TDocStd_Document
from OCP.TopLoc import TopLoc_Location
from OCP.collections import List_TopoDS_Shape, Sequence_TDF_Label
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.gp import gp_Extrinsic_XYZ, gp_Quaternion, gp_Trsf, gp_Vec

from build_cots_library import KICAD
from cable_router import route_harness_for_node
from catalog_ingestor import (
    count_brep_faces,
    read_xcaf_document,
    stabilize_step_occurrences,
    stabilize_step_presentation,
    xcaf_shape,
)
from ingest_upstream_catalog import CACHE_DIR, REPO_ROOT, center_and_write_step, exact_bounds_mm, fetch_bytes

ARCHETYPE = "reachy_mini_v1"
PACKAGE_ID = "1e81967c4e0b"
PACKAGE_URL = f"https://heypcb.ai/world/b/{PACKAGE_ID}"
LICENSE = "CC-BY-NC-SA-4.0"
PRODUCT_SHA256 = "e70267bef2fe938b82a511259610593458f2196bc57316cd08fc55429dfdf2c2"
POLLEN_REVISION = "9d5d5e5ddb40fa81fec553e2de1aac0a1ee5d2f2"
SERVO_URL = (
    "https://raw.githubusercontent.com/lsk0522/microduck/f7ed33d24e9806402b06e4aeab4e0759e0371f80/"
    "cad/redesign/dynamixel/v1.0/parts/xl330/xl330.step"
)
SERVO_SHA256 = "6eb451fbdc758c5327ffcd6b554ddfbe4a7ef899d053bd3667b9bad8de96a2da"
CAMERA_DRAWING = (
    "https://pip-assets.raspberrypi.com/categories/1207-design-files/documents/"
    "RP-008155-DS-1-camera-module-3-wide-mechanical-drawing.pdf"
)
FAN_DRAWING = "https://www.sunonusa.com/product/dc-fan-20x20x10-12/"
STEP_TIMESTAMP = "2026-01-01T00:00:00"
ROUTES = REPO_ROOT / "src/shared/domain/catalog/sources/reachy_mini_routes.json"
BOARD_ORIGINS_MM = {"power_board": (43.975, 39.99), "head_board": (67.245, 37.79), "mic_strip": (55, 5.5)}
BOARDS_BY_SLUG = {"foot-power": "power_board", "head": "head_board", "mic-strip": "mic_strip"}
POSE_FROM_DATUM = {*BOARD_ORIGINS_MM, "mic_foam", "mic_bar"}
FRONT_TO_CAMERA = bd.Rot(0, 0, -90)
FIT_RELIEFS = {
    "foot": ("battery_pack",),
    "turning": ("yaw_servo",),
    "tricap": ("speaker", *(f"servo_{index}" for index in range(1, 7))),
    "glasses_holder": ("lens_r", "lens_l"),
    "head_back": ("head", "head_mic", "antenna_servo_r"),
    **{f"arm_{index}": (f"servo_{index}",) for index in range(1, 7)},
    **{f"lens_cap_{side}": (f"lens_{side}", f"m12_lens_{side}") for side in ("l", "r")},
    **{f"antenna_holder_{side}": (f"antenna_servo_{side}",) for side in ("l", "r")},
    **{f"antenna_interface_{side}": (f"antenna_body_{side}",) for side in ("l", "r")},
}
MATERIALS = {
    "pa12_natural": ("#e8e4dc", "nylon_glass_filled"),
    "pa12_ink": ("#2c3138", "nylon_glass_filled"),
    "cots_metal": ("#9aa4b2", "stainless_steel"),
    "pc_frost": ("#161a20", "optical_glass"),
    "cots_plastic": ("#30353d", "servo_housing"),
    "cots_rubber": ("#25292e", "rubber"),
    "pcb": ("#247052", "fr4_pcb"),
    "servo": ("#262b33", "servo_housing"),
}
BINARY_OPERATORS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
}


@dataclass(frozen=True)
class Part:
    shape: bd.Shape
    material: str
    origin: str
    source_url: str
    source_name: str
    source_digest: str | None = None
    board_document: TDocStd_Document | None = None


def require_digest(payload: bytes, expected: str, name: str) -> None:
    actual = hashlib.sha256(payload).hexdigest()
    if actual != expected:
        raise ValueError(f"{name}: SHA-256 {actual} does not match {expected}")


def load_product(source: Path) -> dict:
    package = json.loads((source / "heypcb-package.json").read_bytes())
    if package["source"]["id"] != PACKAGE_ID or package["licence"]["id"] != LICENSE:
        raise ValueError(f"Expected the published HeyPCB {PACKAGE_ID} package with licence {LICENSE}")
    payload = (source / "product.json").read_bytes()
    require_digest(payload, PRODUCT_SHA256, "HeyPCB product.json")
    product = json.loads(payload)
    if product["schema"] != "heypcb.product.v2" or product["docRev"] != 55:
        raise ValueError("Expected HeyPCB product revision 55")
    return product


def evaluate_datum(expression: str | int | float, parameters: dict) -> float:
    if not isinstance(expression, str):
        return float(expression)

    def evaluate(node: ast.expr) -> float:
        match node:
            case ast.Constant(value=value) if type(value) in (int, float):
                return float(value)
            case ast.Name(id=name):
                return float(parameters[name])
            case ast.UnaryOp(op=ast.USub(), operand=operand):
                return -evaluate(operand)
            case ast.BinOp(left=left, op=operation, right=right) if type(operation) in BINARY_OPERATORS:
                return BINARY_OPERATORS[type(operation)](evaluate(left), evaluate(right))
        raise ValueError(f"Unsupported HeyPCB datum expression: {expression!r}")

    return evaluate(ast.parse(expression, mode="eval").body)


def parameter_values(parameters: dict) -> dict:
    return {key: entry["value"] for key, entry in parameters.items()}


def location(position, rotation=(0, 0, 0)) -> bd.Location:
    quaternion = gp_Quaternion()
    quaternion.SetEulerAngles(gp_Extrinsic_XYZ, *(math.radians(angle) for angle in rotation))
    transform = gp_Trsf()
    transform.SetRotation(quaternion)
    transform.SetTranslationPart(gp_Vec(*position))
    return bd.Location(transform)


def servo_frame() -> bd.Location:
    transform = gp_Trsf()
    transform.SetValues(0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, -8)
    return bd.Location(transform)


def camera_geometry() -> bd.Shape:
    with bd.BuildPart() as camera:
        with bd.Locations((0, 0, 0.56)):
            bd.Box(25, 23.862, 1.12)
        with bd.Locations(*((x, y, 0) for x in (-10.5, 10.5) for y in (-6.25, 6.25))):
            bd.Cylinder(1.1, 4, mode=bd.Mode.SUBTRACT)
        with bd.Locations((0, 0, 1.12)):
            bd.Box(8.9, 8.9, 2.18, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
        with bd.Locations((0, 0, 3.30)):
            bd.Cylinder(3.475, 5, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
    return camera.part


def fan_geometry() -> bd.Shape:
    with bd.BuildPart() as frame:
        with bd.BuildSketch():
            bd.RectangleRounded(20, 20, 1)
            bd.Circle(8.6, mode=bd.Mode.SUBTRACT)
            with bd.Locations(*((x, y) for x in (-8.1, 8.1) for y in (-8.1, 8.1))):
                bd.Circle(1.05, mode=bd.Mode.SUBTRACT)
        bd.extrude(amount=10)
        with bd.Locations((0, 0, 1)):
            bd.Box(18.2, 1.4, 2)
            bd.Cylinder(3.7, 5, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
        for angle in range(0, 360, 72):
            blade = bd.Pos(5.4, 0, 4.6) * bd.Rot(21, 0, 22) * bd.Box(5, 2.2, 0.7, mode=bd.Mode.PRIVATE)
            bd.insert(bd.Rot(0, 0, angle) * blade)
    return frame.part


class HeyPcbAssembly:
    def __init__(self, product: dict):
        self.product = product
        self.nodes = {node["id"]: node for node in product["nodes"]}
        self.definitions = product["definitions"]
        self.parameters = parameter_values(product["parameters"])
        self.fixed = {
            relation["moving"]["nodeId"]: relation
            for relation in product["relations"]
            if relation["kind"] == "fixed"
        }

    def datum(self, node_id: str, name: str) -> bd.Location:
        node = self.nodes[node_id]
        explicit = node.get("datums", {}).get(name)
        if explicit is not None:
            position = list(explicit["position"])
            for axis in range(3):
                binding = node.get("parameterBindings", {}).get(f"datums.{name}.position.{axis}")
                if binding is not None:
                    position[axis] = self.parameters[binding]
            return location(position, explicit["rotation"])
        definition = self.definitions[node["definition"]]
        frame = definition["interfaces"][name]["frame"]
        parameters = parameter_values(definition["parameters"])
        return location(
            [evaluate_datum(value, parameters) for value in frame["position"]],
            [evaluate_datum(value, parameters) for value in frame["rotation"]],
        )

    @cache
    def pose(self, node_id: str) -> bd.Location:
        if node_id in POSE_FROM_DATUM:
            fixed = self.fixed[node_id]
            reference, moving = fixed["reference"], fixed["moving"]
            reference_pose = self.pose(reference["nodeId"]) * self.datum(reference["nodeId"], reference["datum"])
            moving_datum = self.datum(node_id, moving["datum"])
            if node_id == "mic_strip":
                reference_pose *= bd.Rot(180, 0, 0)
            if node_id in {"mic_foam", "mic_bar"}:
                return bd.Pos(*(reference_pose.position - moving_datum.position))
            return reference_pose * moving_datum.inverse()
        if node_id.startswith("servo_"):
            mount = self.fixed[node_id]["reference"]
            pocket = self.pose(mount["nodeId"]) * self.datum(mount["nodeId"], mount["datum"])
            rotation = location((0, 0, 0), (90, 0, pocket.orientation.Z))
            return bd.Pos(*(pocket.position - (rotation * bd.Pos(0, -24.5, -8)).position)) * rotation
        pose = self.nodes[node_id]["transform"]
        return location(pose["position"], pose["rotation"])

    @cache
    def scripted_part(self, recipe: str) -> Part:
        definition = self.definitions.get(recipe)
        source = definition["script"] if definition else self.nodes[recipe]["source"]
        parameters = parameter_values(definition["parameters"]) if definition else self.parameters
        emitted = []

        def emit(name: str, shape: bd.Shape, material: str) -> None:
            emitted.append((name, shape, material))

        exec(compile(source, recipe, "exec"), {"bd": bd, "math": math, "emit": emit, "parameters": dict(parameters)})
        if len(emitted) != 1:
            raise ValueError(f"Expected one BRep from {recipe}, got {len(emitted)}")
        name, shape, material = emitted[0]
        return Part(shape, material, "parametric_cad", PACKAGE_URL, f"HeyPCB {name}", PRODUCT_SHA256)


def export_board(source: Path, staging: Path, node: dict) -> Part:
    node_id = node["id"]
    binding = node["boardBinding"]
    source_file = source / binding["path"]
    payload = source_file.read_bytes()
    require_digest(payload, binding["boardSourceSha256"], binding["path"])
    pcb = staging / source_file.name
    pcb.write_bytes(payload)
    step = pcb.with_suffix(".step")
    origin = "x".join(map(str, BOARD_ORIGINS_MM[node_id])) + "mm"
    subprocess.run(
        [*KICAD, "pcb", "export", "step", "--no-components", "--include-silkscreen",
         "--user-origin", origin, "--output", str(step), str(pcb)],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180,
    )
    document = read_xcaf_document(step)
    return Part(
        bd.Compound(xcaf_shape(document)), "pcb", "kicad_pcb_step",
        f"kicad://heypcb/{binding['sourceProjectId']}/{pcb.name}", f"HeyPCB {pcb.name}",
        binding["boardSourceSha256"], document,
    )


def export_colored_board(document, pose: bd.Location, path: Path, center: tuple[float, ...]) -> None:
    placement = (bd.Pos(*(-value for value in center)) * pose).wrapped
    tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    roots = Sequence_TDF_Label()
    tool.GetFreeShapes(roots)
    for root in roots:
        if not tool.SetLocation(root, placement.Multiplied(tool.GetLocation_s(root)), TDF_Label()):
            raise RuntimeError(f"Could not center PCB geometry for {path.name}")
    tool.UpdateAssemblies()
    writer = STEPCAFControl_Writer()
    if not writer.Transfer(document):
        raise RuntimeError(f"Could not transfer PCB geometry for {path.name}")
    header = APIHeaderSection_MakeHeader(writer.ChangeWriter().Model())
    header.SetTimeStamp(TCollection_HAsciiString(STEP_TIMESTAMP))
    if writer.Write(str(path)) != IFSelect_RetDone:
        raise RuntimeError(f"Could not write PCB geometry for {path.name}")
    stabilize_step_presentation(path)


def load_parts(assembly: HeyPcbAssembly, source: Path, staging: Path) -> dict[str, Part]:
    servo_payload = fetch_bytes(SERVO_URL)
    require_digest(servo_payload, SERVO_SHA256, SERVO_URL)
    upstream_step = staging / "xl330.step"
    upstream_step.write_bytes(servo_payload)
    servo = Part(
        bd.import_step(upstream_step).moved(servo_frame()), "servo", "cots_library_step",
        SERVO_URL, "Microduck XL330 mechanical model", SERVO_SHA256,
    )
    bought_parts = {
        "dxl_xl330_m288_t": servo, "dxl_xl330_m077_t": servo, "dxl_xc330_m288_t": servo,
        "cam_rpi_module_3_wide": Part(camera_geometry(), "pcb", "parametric_cad", CAMERA_DRAWING, "Raspberry Pi Camera Module 3 Wide mechanical drawing"),
        "fan_sunon_mf20100v2": Part(fan_geometry(), "servo", "parametric_cad", FAN_DRAWING, "Sunon MF20100V2-1000U-S99 reference dimensions"),
    }
    parts = {}
    for node_id, node in assembly.nodes.items():
        match node["type"]:
            case "script":
                parts[node_id] = assembly.scripted_part(node.get("definition", node_id))
            case "pcb":
                parts[node_id] = export_board(source, staging, node)
            case "component":
                parts[node_id] = bought_parts[node["component"]]
            case other:
                raise ValueError(f"{node_id}: unsupported HeyPCB node type {other!r}")
    return parts


GROUPS = {
    "base": ("Base & Yaw", "foot turning bearing bowl top_shell yaw_servo foot_pad_1 foot_pad_2 foot_pad_3 foot_pad_4 foot_pad_5"),
    "neck": (
        "Stewart Neck",
        "main_plate tricap rod_1 rod_2 rod_3 rod_4 rod_5 rod_6 head upper_ball_1 upper_ball_2 upper_ball_3 "
        "upper_ball_4 upper_ball_5 upper_ball_6 lower_ball_1 lower_ball_2 lower_ball_3 lower_ball_4 lower_ball_5 "
        "lower_ball_6 arm_1 arm_2 arm_3 arm_4 arm_5 arm_6 servo_1 servo_2 servo_3 servo_4 servo_5 servo_6",
    ),
    "head": (
        "Head Shell & Optics",
        "lens_cap_r lens_r lens_cap_l lens_l m12_lens_r m12_lens_l glasses_holder head_front head_mic head_back "
        "antenna_holder_l antenna_holder_r antenna_interface_l antenna_interface_r antenna_body_l antenna_body_r "
        "antenna_l antenna_r mic_foam mic_bar",
    ),
    "electronics": (
        "Electronics & PCBs",
        "antenna_servo_l antenna_servo_r speaker battery_pack key_cap usb_socket camera fan power_board head_board mic_strip",
    ),
    "wiring": ("Cable Harnesses", ""),
}

GROUP_BY_NODE = {node: group for group, (_, parts) in GROUPS.items() for node in parts.split()}
ROOT_ID = "proj_reachy_mini"
CONNECTION_TYPES = {"fixed": "rigid_fastener", "revolute": "revolute_joint", "ball": "axial_mount"}
SERVO_MANUALS = {
    "dxl_xl330_m288_t": "https://emanual.robotis.com/docs/en/dxl/x/xl330-m288/",
    "dxl_xl330_m077_t": "https://emanual.robotis.com/docs/en/dxl/x/xl330-m077/",
    "dxl_xc330_m288_t": "https://emanual.robotis.com/docs/en/dxl/x/xc330-m288/",
}
RATINGS = {
    "BAT": ("dc_power", 5.0, 6.4, 7.3, 4.0, 0),
    "PWR": ("dc_power", 5.0, 6.8, 7.3, 4.0, 0),
    "USB": ("usb_data", 4.75, 5.0, 5.25, 0.5, 0),
    "SPK": ("analog_audio", 0.0, 4.47, 5.0, 1.12, 1),
    "FAN": ("pwm_signal", 4.5, 5.0, 5.5, 0.08, 1),
    "CAM": ("mipi_csi2", 3.1, 3.3, 3.5, 0.25, 0),
    "MIC": ("pdm_audio", 1.62, 1.8, 1.98, 0.02, 1),
}
SERVO_RAIL = (6.8, 6.8, 7.3)
SERVO_INPUT = (3.7, 5.0, 6.0)
SERVO_CHAIN_SOURCE = {"C2": 0, "C5": 1, "C7": 1, "C6": 0, "C8": 0, "C10": 0}


def component_id(node_id: str) -> str:
    return f"comp_reachy_{node_id.lower()}"


def subsystem_id(group: str) -> str:
    return f"sub_reachy_{group}"


def world_direction(vector) -> list[float]:
    x, y, z = vector
    return [float(x), float(z), -float(y)]


def world_position(vector) -> list[float]:
    return [round(value / 1000, 9) for value in world_direction(vector)]


def catalog_node(
    node_id: str, parent_id: str | None, name: str, level: str, category: str, color: str, material: str,
) -> dict:
    return {
        "id": node_id, "parentId": parent_id, "name": name, "level": level,
        "depth": ("project", "subsystem", "component").index(level), "category": category,
        "colorHex": color, "dimensionsMm": [1, 1, 1], "restPositionMeters": [0, 0, 0],
        "explodeDirection": [0, 0, 0], "explodeDistanceMeters": 0, "materialHint": material,
        "origin": "parametric_cad", "spdxLicense": LICENSE, "sourceName": "HeyPCB Reachy Mini replica",
        "sourceUrl": PACKAGE_URL, "stepFixtureName": None, "specifications": {},
    }


def relieve_fits(solids: dict) -> dict:
    relieved = dict(solids)
    for node_id, mating_ids in FIT_RELIEFS.items():
        arguments, tools = List_TopoDS_Shape(), List_TopoDS_Shape()
        arguments.Append(solids[node_id])
        for mating_id in mating_ids:
            tools.Append(solids[mating_id])
        cut = BRepAlgoAPI_Cut()
        cut.SetArguments(arguments)
        cut.SetTools(tools)
        cut.SetNonDestructive(True)
        cut.SetUseOBB(True)
        cut.SetRunParallel(True)
        cut.Build()
        if not cut.IsDone() or not BRepCheck_Analyzer(cut.Shape()).IsValid():
            raise RuntimeError(f"{node_id}: invalid mating relief for {', '.join(mating_ids)}")
        relieved[node_id] = cut.Shape()
    return relieved


def physical_nodes(assembly: HeyPcbAssembly, parts: dict[str, Part], staging: Path) -> tuple[dict, dict]:
    nodes = {}
    fixture_dir = staging / "reachy_mini"
    fixture_dir.mkdir()
    poses = {node_id: FRONT_TO_CAMERA * assembly.pose(node_id) for node_id in parts}
    solids = relieve_fits({node_id: part.shape.moved(poses[node_id]).wrapped for node_id, part in parts.items()})
    for node_id, part in parts.items():
        authored = assembly.nodes[node_id]
        pose = poses[node_id]
        shape = solids[node_id]
        target = fixture_dir / f"{node_id}.step"
        if part.board_document is None:
            metadata = center_and_write_step(shape, target, timestamp=STEP_TIMESTAMP)
            metadata["dimensionsMm"] = [round(b - a, 4) for a, b in zip(*exact_bounds_mm(shape))]
            target.write_text(stabilize_step_occurrences(target.read_text(encoding="ascii")), encoding="ascii")
        else:
            if not BRepCheck_Analyzer(shape).IsValid():
                raise RuntimeError(f"{node_id}: invalid source BRep")
            bounds = exact_bounds_mm(shape)
            center = np.mean(bounds, axis=0)
            export_colored_board(part.board_document, pose, target, tuple(center))
            metadata = {
                "restPositionMeters": world_position(center),
                "dimensionsMm": [round(b - a, 4) for a, b in zip(*bounds)],
                "faceCount": count_brep_faces(shape),
            }
        color, skin = MATERIALS[part.material]
        group = GROUP_BY_NODE[node_id]
        category = "electronics" if group == "electronics" or part.origin == "cots_library_step" else "mechanical"
        node = catalog_node(component_id(node_id), subsystem_id(group), authored["name"], "component", category, color, skin)
        x, y, z = metadata["restPositionMeters"]
        spread = np.array([x, y - (0.22 if group in {"head", "electronics"} and y > 0.17 else 0.065), z])
        direction = spread / np.linalg.norm(spread) if np.linalg.norm(spread) else np.array([0, 1, 0])
        width, depth, height = metadata["dimensionsMm"]
        specifications = {"brepFaces": metadata["faceCount"], "heypcbNodeId": node_id}
        if part.source_digest is not None:
            specifications["upstreamStepSha256" if part.origin == "cots_library_step" else "sourceSha256"] = part.source_digest
        if authored.get("component") in SERVO_MANUALS:
            specifications["datasheetUrl"] = SERVO_MANUALS[authored["component"]]
            specifications["sourceLicense"] = "No license declared for this STEP at the pinned revision"
            specifications["partNumber"] = authored["component"]
            specifications["operatingVoltageMaxV"] = 6
        node.update(
            origin=part.origin, sourceUrl=part.source_url, sourceName=part.source_name,
            spdxLicense="NOASSERTION" if part.origin == "cots_library_step" else LICENSE,
            stepFixtureName=f"reachy_mini/{target.name}", expectedStepSha256=hashlib.sha256(target.read_bytes()).hexdigest(),
            dimensionsMm=[width, height, depth], restPositionMeters=metadata["restPositionMeters"],
            explodeDirection=[round(float(value), 6) for value in direction], explodeDistanceMeters=0.08,
            specifications=specifications,
        )
        nodes[node_id] = node
        print(f"Wrote {target.name} ({metadata['faceCount']} faces)", flush=True)
    return nodes, solids


def mechanical_relationships(assembly: HeyPcbAssembly, nodes: dict[str, dict]) -> list[dict]:
    relationships, connected = [], set()
    for relation in assembly.product["relations"]:
        moving, reference = relation["moving"], relation["reference"]
        first, second = reference["nodeId"], moving["nodeId"]
        relationships.append({
            "id": f"rel_reachy_{relation['id'].lower()}",
            "fromComponentId": nodes[first]["id"], "toComponentId": nodes[second]["id"],
            "connectionType": CONNECTION_TYPES[relation["kind"]],
            "howConnected": relation.get("name") or f"Seat the ball joint between {nodes[second]['name']} and {nodes[first]['name']}.",
            "whyConnected": f"The {reference['datum'].replace('_', ' ')} and {moving['datum'].replace('_', ' ')} datums locate the two parts.",
        })
        connected.update((first, second))
    for node_id, node in nodes.items():
        if node_id not in connected:
            support = "foot" if node_id.startswith("foot_pad_") or node_id in {"usb_socket", "key_cap"} else "head_back"
            relationships.append({
                "id": f"rel_reachy_install_{node_id}",
                "fromComponentId": nodes[support]["id"], "toComponentId": node["id"],
                "connectionType": "assembly_mount",
                "howConnected": f"Seat {node['name']} against {nodes[support]['name']}.",
                "whyConnected": "The mounting surface retains the part in its assembled position.",
            })
    return relationships


def cable_endpoint(end: dict) -> tuple[str, str]:
    match end["on"]:
        case "board":
            return BOARDS_BY_SLUG[end["board"]], end["ref"].lower()
        case "port":
            return end["nodeId"], end["port"]
        case "pigtail" | "panel":
            return end["nodeId"], end["datum"]
    raise ValueError(f"Unsupported cable endpoint {end['on']!r}")


def circuit_ratings(cable_id: str, index: int, node_id: str) -> tuple[str, str, tuple[float, ...], float]:
    if cable_id in RATINGS:
        bus, low, nominal, high, current, source_index = RATINGS[cable_id]
        return bus, "source" if index == source_index else "sink", (low, nominal, high), current
    source_index = SERVO_CHAIN_SOURCE.get(cable_id, 0)
    if index == source_index:
        return "ttl_serial", "source", SERVO_RAIL, 2.15
    if node_id.endswith("_board"):
        return "ttl_serial", "bidirectional", SERVO_RAIL, 2.15
    return "ttl_serial", "sink", SERVO_INPUT, 2.15 if node_id == "yaw_servo" else 1.47


def cable_ports(nodes: dict, cable: dict, route: list) -> list[tuple[dict, dict]]:
    endpoints = []
    anchors = ((route[0], route[1]), (route[-1], route[-2]))
    for index, (end, (position, inside)) in enumerate(zip(cable["ends"].values(), anchors)):
        node_id, port_name = cable_endpoint(end)
        node = nodes[node_id]
        bus, role, voltages, current = circuit_ratings(cable["id"], index, node_id)
        exit_vector = np.asarray(inside) - position
        exit_direction = exit_vector / np.linalg.norm(exit_vector)
        port = {
            "portId": f"port_{cable['id'].lower()}_{port_name}", "label": port_name.replace("_", " ").upper(),
            "connectorType": end.get("connector", {}).get("series", "Attached lead"),
            "busKind": bus, "role": role, "minVoltageV": voltages[0], "nominalVoltageV": voltages[1],
            "wireColorsHex": ["#252932" if cable["shield"] else "#aa312e" if bus == "dc_power" else "#b4a593"],
            "maxVoltageV": voltages[2], "maxCurrentA": current,
            "localPositionMeters": [round(a - b, 9) for a, b in zip(position, node["restPositionMeters"])],
            "exitDirection": [float(value) for value in exit_direction],
        }
        node.setdefault("ports", []).append(port)
        endpoints.append((node, port))
    return endpoints


def cable_catalog(assembly: HeyPcbAssembly, nodes: dict) -> tuple[dict, list[dict]]:
    routes = json.loads(ROUTES.read_text(encoding="utf-8"))
    cable_nodes, circuit_relationships = {}, []
    for cable in assembly.product["cables"]:
        cable_id = cable["id"]
        route = routes[cable_id]
        (first, port_a), (second, port_b) = cable_ports(nodes, cable, route)
        relationship_id = f"rel_reachy_cable_{cable_id.lower()}"
        circuit_relationships.append({
            "id": relationship_id,
            "fromComponentId": first["id"], "toComponentId": second["id"],
            "fromPortId": port_a["portId"], "toPortId": port_b["portId"],
            "connectionType": "power_bus" if port_a["busKind"] == "dc_power" else "electrical_bus",
            "howConnected": cable["name"],
            "whyConnected": f"The {port_a['busKind'].replace('_', ' ')} connection joins {first['name']} and {second['name']}.",
            "wireBundleDiameterMm": cable.get("diameterMm", cable.get("widthMm", 2) * 0.32),
            "routingStyle": "filleted_polyline",
            "routingWaypointsMeters": route[1:-1],
        })
        node = catalog_node(component_id(f"cable_{cable_id}"), subsystem_id("wiring"), cable["name"], "component", "wiring", "#292e37", "silicone_wire")
        node.update(
            origin="procedural_harness", sourceUrl=f"harness://heypcb/{PACKAGE_ID}/{cable_id}",
            stepFixtureName=f"reachy_mini/cable_{cable_id.lower()}.step",
            explodeDirection=[0, 1, 0], explodeDistanceMeters=0.055,
            specifications={
                "relationshipId": relationship_id, "sourceCableId": cable_id, "nominalLengthMm": cable["length"]["nominalMm"],
                "conductorCount": cable["conductors"], "cableProfile": cable["kind"],
            },
        )
        cable_nodes[cable_id] = node
        circuit_relationships.append({
            "id": f"rel_reachy_mount_cable_{cable_id.lower()}",
            "fromComponentId": first["id"], "toComponentId": node["id"], "connectionType": "assembly_mount",
            "howConnected": f"Install the cable at both connectors: {port_a['label']} and {port_b['label']}.",
            "whyConnected": "The cable carries the rated connection between the two installed components.",
        })
    return cable_nodes, circuit_relationships


def instruction_steps(assembly: HeyPcbAssembly, nodes: dict, cables: dict, relationships: list[dict]) -> list[dict]:
    subassemblies = {entry["id"]: entry["nodeIds"] for entry in assembly.product["assemblySequence"]["subassemblies"]}
    steps = []
    installed = set()
    for index, step in enumerate(assembly.product["assemblySequence"]["steps"], 1):
        parts = {
            nodes[part]["id"]
            for entry in step["place"]
            for part in subassemblies.get(entry, [entry])
            if part in nodes
        }
        cable_ids = dict.fromkeys(entry["cable"] for entry in [*step["plug"], *step["route"]] if entry["cable"] in cables)
        selected_cables = [cables[key] for key in cable_ids]
        parts.update(cable["id"] for cable in selected_cables)
        rel_ids = {cable["specifications"]["relationshipId"] for cable in selected_cables}
        rel_ids.update(
            relationship["id"] for relationship in relationships
            if relationship["toComponentId"] in parts and relationship["fromComponentId"] in parts | installed
        )
        installed.update(parts)
        steps.append({
            "id": f"step_reachy_{step['id']}", "order": index,
            "title": "Review the electrical warning before powering on" if step["id"] == "s51" else step["title"],
            "summary": (
                "HeyPCB documents a 6.8 V servo rail. The listed ROBOTIS servos are rated up to 6.0 V."
                if step["id"] == "s51" else step.get("note") or step["title"]
            ),
            "componentIds": sorted(parts), "relationshipIds": sorted(rel_ids),
        })
    return steps


def make_catalog(assembly: HeyPcbAssembly, nodes: dict, solids: dict, staging: Path) -> dict:
    root = catalog_node(ROOT_ID, None, "Reachy Mini", "project", "project", "#e8e4dc", "assembly_root")
    assembly_bounds = np.array([exact_bounds_mm(shape) for shape in solids.values()])
    dimensions = assembly_bounds[:, 1].max(axis=0) - assembly_bounds[:, 0].min(axis=0)
    root["dimensionsMm"] = [round(dimensions[axis], 2) for axis in (0, 2, 1)]
    root["specifications"] = {
        "originalCreator": "Pollen Robotics", "reconstructionAuthor": "HeyPCB", "sourceRevision": POLLEN_REVISION,
        "heypcbDocumentRevision": 55, "nominalServoRailV": 6.8, "servoMaximumRatedV": 6.0,
    }
    groups = [catalog_node(subsystem_id(group), ROOT_ID, title, "subsystem", group, "#e8e4dc", "assembly_root")
              for group, (title, _) in GROUPS.items()]
    cables, circuits = cable_catalog(assembly, nodes)
    relationships = [*mechanical_relationships(assembly, nodes), *circuits]
    catalog = {
        "archetypeId": ARCHETYPE, "title": "Reachy Mini",
        "summary": "desktop companion robot reconstructed by HeyPCB from Pollen Robotics' Reachy Mini Wireless",
        "keywords": ["reachy", "reachy mini", "desktop companion", "pollen", "stewart", "antennas", "companion robot"],
        "rootNodeId": ROOT_ID, "generationMode": "reference_catalog", "spdxLicense": LICENSE,
        "nodes": [root, *groups, *nodes.values(), *cables.values()], "relationships": relationships,
        "assemblySteps": instruction_steps(assembly, nodes, cables, relationships),
    }
    placed = {nodes[key]["id"]: shape for key, shape in solids.items()}
    for cable in cables.values():
        resolved = route_harness_for_node(cable, catalog, staging, placed)
        cable.update(
            expectedStepSha256=resolved["sha256"], dimensionsMm=resolved["dimensionsMm"],
            restPositionMeters=resolved["restPositionMeters"],
        )
        cable["specifications"]["brepFaces"] = resolved["faceCount"]
        print(f"Wrote {cable['stepFixtureName']} ({resolved['faceCount']} faces)", flush=True)
    return catalog


def main() -> int:
    parser = argparse.ArgumentParser(description="Ingest the pinned HeyPCB Reachy Mini revision into Zappd")
    parser.add_argument("--source-dir", type=Path, default=Path.home() / "Downloads" / "heypcb-reachy-mini")
    parser.add_argument("--cache-dir", type=Path, default=CACHE_DIR)
    parser.add_argument("--catalog-json", type=Path, default=REPO_ROOT / "src/shared/domain/catalog/assemblies/reachy_mini_v1.json")
    args = parser.parse_args()
    source = args.source_dir.resolve()
    assembly = HeyPcbAssembly(load_product(source))
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=args.cache_dir) as temporary:
        staging = Path(temporary)
        parts = load_parts(assembly, source, staging)
        nodes, solids = physical_nodes(assembly, parts, staging)
        catalog = make_catalog(assembly, nodes, solids, staging)
        fixtures = args.cache_dir / "reachy_mini"
        fixtures.mkdir(exist_ok=True)
        for fixture in (staging / "reachy_mini").iterdir():
            fixture.replace(fixtures / fixture.name)
        args.catalog_json.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
