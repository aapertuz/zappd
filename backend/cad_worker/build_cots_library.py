from __future__ import annotations

import hashlib
import json
import math
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.request import urlopen
from uuid import NAMESPACE_URL, uuid5

from OCP.APIHeaderSection import APIHeaderSection_MakeHeader
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.TCollection import TCollection_HAsciiString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.collections import Sequence_TDF_Label
from OCP.gp import gp_Ax1, gp_Dir, gp_Identity, gp_Pnt, gp_Translation, gp_Trsf, gp_Vec

from catalog_ingestor import (
    REPO_COTS_LIBRARY_DIR,
    read_and_validate_step,
    read_xcaf_document,
    read_xcaf_face_colors,
    stabilize_step_presentation,
)
from geometry_pipeline import shape_bounds_mm


ROOT = Path(__file__).resolve().parents[2]
BOARD_DIR = Path(__file__).resolve().with_name("kicad_boards")
REGISTRY = ROOT / "src/shared/domain/catalog/cots/index.json"
KICAD = ("uvx", "--from", "kicode-pcb==10.99.0.dev20261106", "kicad-cli")
LIBRARIES = "https://gitlab.com/kicad/libraries"
MODEL_REVISION = "706ebf838bc436fbfd8ff19ad9da44e89574bc11"
FOOTPRINT_REVISION = "99c3ec924043f946957f50630b653cc6698d877a"
KICAD_MODEL_LICENSE = "CC-BY-SA-4.0"
BATTERY_SOURCE = (
    "https://raw.githubusercontent.com/robotjaol/custom-components/main/"
    "BATTERY_HOLDER_18650_X3/3%20Battery%20Holder%20With%20Batteries.step"
)
BATTERY_SHA256 = "11a62d405fbe43da90d273607144e3eabe7909fb6395b4e93097501dc9f34d90"
BOARD_ORIGIN_MM = 100
BOARD_THICKNESS_MM = 1.6
USB_SHARED_PADS = {
    "A1": "GND", "B12": "GND",
    "A12": "GND", "B1": "GND",
    "A4": "VBUS", "B9": "VBUS",
    "A9": "VBUS", "B4": "VBUS",
}


@dataclass(frozen=True)
class Model:
    library: str
    name: str
    step_sha256: str
    footprint_sha256: str
    footprint_name: str | None = None

    @property
    def step_path(self) -> str:
        return f"{self.library}.3dshapes/{self.name}.step"

    @property
    def footprint_path(self) -> str:
        return f"{self.library}.pretty/{self.footprint_name or self.name}.kicad_mod"


USB_C = Model(
    "Connector_USB", "USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal",
    "6338ce740fa231c2d3dcc6384e0576994a47240a312a21413cb85d76990a69a0",
    "3b8d7da3cae5114ec83022a759a78925113bc2eeec100ea447594f6d8687e4b8",
)
BARREL = Model(
    "Connector_BarrelJack", "BarrelJack_Horizontal",
    "53f1b2714ed169b5e314b9b42cc9943303769e29e0debdfb4ef7a0e2c4f369dd",
    "dabae1eb824b47f8565afa86ff93f2f5f473e1eaf02cab77eae4090f77e4e6f4",
)
JST_PH = Model(
    "Connector_JST", "JST_PH_B3B-PH-K_1x03_P2.00mm_Vertical",
    "00cbe1522070150893f96728ffaa78070972f025d63c45f899e18b3060a41f2d",
    "dd50eb4b509c1f7584aff9b58968d46cfac74ce253d4d5cf31c0565c3bf53f4c",
)
JST_PH_HORIZONTAL = Model(
    "Connector_JST", "JST_PH_S3B-PH-K_1x03_P2.00mm_Horizontal",
    "7e9becae7d5b98a52563a1a638b94fd3c90d7e56e71caedeb779862e91147739",
    "e1536f71fadb2bcb735cc91360ecf558f92ed45bcc42831e606aa2c128c38c63",
)
JST_GH = Model(
    "Connector_JST", "JST_GH_BM04B-GHS-TBT_1x04-1MP_P1.25mm_Vertical",
    "ebc503b4b58cad5873c7cdeb695315baf8bea08dd22aa49873b0104671b78d59",
    "c0e5c962366864b39ad3a295bb6419547e18f0f5ac49060d75ea51d0e7079732",
)
XT60 = Model(
    "Connector_AMASS", "AMASS_XT60-M_1x02_P7.2mm_Vertical",
    "79c46051de822e2939ebbdbe2d708897adffa66bdc61a011b7f559c4a8565679",
    "45053251eebf98805e9e7e301c7fc5405cb9c8df6ee612adf55f7866b8dade97",
    "AMASS_XT60-M_1x02_P7.20mm_Vertical",
)
PIN_1X03 = Model(
    "Connector_PinHeader_2.54mm", "PinHeader_1x03_P2.54mm_Vertical",
    "b91b4ac5acf1a0d28a676703db972d17b8f11ef26a85b58d60786a69246b921b",
    "e5f24b6fea852f86171042806da48490229c9c8025b6d266b8cad6485b26e79f",
)
PIN_2X20 = Model(
    "Connector_PinHeader_2.54mm", "PinHeader_2x20_P2.54mm_Vertical",
    "3e3ee5e050716acbc8e6e4fc2778dce66ea1c9b17bdf6583ec399dabef67e264",
    "0d860de8c4c7b7413ad8b13cf4f1aa389bafeec053f4004834c98c1b95582cd0",
)
LQFP = Model(
    "Package_QFP", "LQFP-64_10x10mm_P0.5mm",
    "b0c827bc5c05552175d28affe44a5bd2ab45c9c36efff6ff07a74cc449b13db4",
    "f5a3abeefd7fdfa39fb685c0d80538f6fed111d00da42bf82decb0b6d2293101",
)
SOIC = Model(
    "Package_SO", "SOIC-16_3.9x9.9mm_P1.27mm",
    "d5eeddb4c0b304dc61950919b126fc61d7586abd5f16ab71a2a79759ec6498bf",
    "f9b5075740f7816c540ae1137f025d659beaec522ed7b86b1a5274cc9a2d8a25",
)
CAPACITOR = Model(
    "Capacitor_THT", "CP_Radial_D8.0mm_P3.50mm",
    "abedfe603cd28231e16fb158d7b3f8875be74514f602e356364f48f073d0ef8e",
    "e7256cc327aa5d1bc5410a487248fa9b5e3d25153b2315201d5da5108cb49580",
)
MOSFET = Model(
    "Package_TO_SOT_SMD", "TDSON-8-1",
    "5a963e380dc0ff0eec7e2ba3f7e348613ee7c8d464841726d7b5dfbac6af3411",
    "fb0d8fb645f7d7c8733df1fe07e21dff3777accce665701217fb738337cc7a56",
)
MODELS = (USB_C, BARREL, JST_PH, JST_PH_HORIZONTAL, JST_GH, XT60, PIN_1X03, PIN_2X20, LQFP, SOIC, CAPACITOR, MOSFET)


Vector = tuple[float, float, float]


@dataclass(frozen=True)
class Port:
    id: str
    label: str
    connector_type: str
    bus_kind: str
    model_anchor_mm: Vector
    model_exit: Vector = (0, 0, 1)


@dataclass(frozen=True)
class Footprint:
    reference: str
    x: float
    y: float
    model: Model | None = None
    port: Port | None = None


@dataclass(frozen=True)
class Board:
    id: str
    name: str
    width: float
    length: float
    footprints: tuple[Footprint, ...]
    mounting_pitch: tuple[float, float] | None = None
    mounting_diameter: float = 2.5
    rotation_x_degrees: float = 0


def usb_port(label: str) -> Port:
    return Port("usb", label, "USB-C", "usb_data", (0, -3.675, 1.65), (0, -1, 0))


BARREL_PORT = Port("dc_in", "DC power input", "DC barrel jack", "dc_power", (-13.8, 0, 6.4), (-1, 0, 0))
ESC_PORT = Port("esc", "Flight controller / ESC link", "JST-GH 4-pin", "pwm_signal", (0, 0, 4.2))
RX_PORT = Port("rx", "Receiver UART", "JST-GH 4-pin", "i2c_spi_uart", (0, 0, 4.2))


def servo_port(index: int) -> Port:
    return Port(f"servo_{index}", f"Servo bus {index}", "JST-PH 3-pin", "ttl_serial", (2, 0, 6))


BOARDS = (
    Board(
        "kicad_so100_bus_servo_adapter", "SO-100 bus servo adapter", 36, 44,
        (
            Footprint("J1", 5, 18.5, USB_C, usb_port("USB data")),
            Footprint("J2", -4.8, 7.5, BARREL, BARREL_PORT),
            Footprint("J3", -11, -9, JST_PH, servo_port(1)),
            Footprint("J4", 2, -9, JST_PH, servo_port(2)),
            Footprint("U1", 9, 0, SOIC),
            Footprint("C1", 0, -17, CAPACITOR),
        ),
        (29, 37),
        rotation_x_degrees=-90,
    ),
    Board(
        "kicad_quad_4in1_esc", "Quadcopter 4-in-1 brushless ESC", 36, 36,
        (
            Footprint("J1", -3.6, 11, XT60, Port("dc_in", "Battery input", "XT60", "dc_power", (3.6, 0, 16))),
            Footprint("J2", 13.03, 6, JST_GH, ESC_PORT),
            Footprint("C1", -14.5, 7.2, CAPACITOR),
            *(Footprint(f"Q{i}", x, y, MOSFET) for i, (x, y) in enumerate(
                ((-12.75, -8), (-4.25, -8), (4.25, -8), (12.75, -8),
                 (-12.75, -0.5), (-4.25, -0.5), (4.25, -0.5), (12.75, -0.5)), 1
            )),
            *(Footprint(f"MP{i}", x, y, port=Port(
                f"motor_{i}", f"Motor {i} phase pads", "3 solder pads", "brushless_phase", (0, 0, 0)
            )) for i, (x, y) in enumerate(((-10.5, -15), (10.5, -15), (10.5, 15), (-10.5, 15)), 1)),
        ),
        (30.5, 30.5),
        3.2,
    ),
    Board(
        "kicad_quad_flight_controller", "Quadcopter flight controller", 36, 36,
        (
            Footprint("U1", 0, 0, LQFP),
            Footprint("J1", 0, 14.5, USB_C, usb_port("USB data")),
            Footprint("J2", -8, -11, JST_GH, ESC_PORT),
            Footprint("J3", 8, -11, JST_GH, RX_PORT),
        ),
        (30.5, 30.5),
        3.2,
    ),
    Board(
        "kicad_quad_elrs_receiver", "ELRS 2.4 GHz receiver", 18, 14,
        (Footprint("U1", -5, 0, SOIC), Footprint("J1", 3.5, 0, JST_GH, RX_PORT)),
    ),
    Board(
        "kicad_nova2_jetson_carrier", "Nova2 Jetson Orin Nano carrier and servo hub", 96, 76,
        (
            Footprint("U1", 6, 6, LQFP),
            Footprint("J1", 42, -24, PIN_2X20, Port("gpio", "Jetson GPIO", "40-pin GPIO", "i2c_spi_uart", (1.27, -24.13, 8.54))),
            Footprint("J2", 15, 34.5, USB_C, usb_port("ZED 2i USB data")),
            Footprint("J3", -34.5, 13, BARREL, BARREL_PORT),
            Footprint("J4", -19, -19, JST_PH, servo_port(1)),
            Footprint("J5", 4, -19, JST_PH, servo_port(2)),
            Footprint("C1", -23, 13, CAPACITOR),
        ),
    ),
)


def pinned_download(url: str, path: Path, expected_sha256: str, fallback_url: str | None = None) -> bytes:
    if path.is_file():
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() == expected_sha256:
            return data

    for source in (url, fallback_url) if fallback_url else (url,):
        try:
            with urlopen(source, timeout=60) as response:
                data = response.read()
        except HTTPError as error:
            if error.code != 404 or source != url or fallback_url is None:
                raise
            continue
        if hashlib.sha256(data).hexdigest() == expected_sha256:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            return data
    raise RuntimeError(f"Upstream digest mismatch for {url}: expected {expected_sha256}")


def fetch_library_file(repository: str, path: str, digest: str, revision: str, destination: Path) -> bytes:
    base = f"{LIBRARIES}/{repository}/-/raw"
    return pinned_download(f"{base}/master/{path}", destination, digest, f"{base}/{revision}/{path}")


def board_footprint(placement: Footprint, libraries: dict[Model, str], board_id: str) -> str:
    x = BOARD_ORIGIN_MM + placement.x
    y = BOARD_ORIGIN_MM + placement.y
    if placement.model is None:
        pads = "\n".join(
            f'  (pad "{i}" smd rect (at {dx} 0) (size 1.1 1.8) (layers "F.Cu" "F.Mask"))'
            for i, dx in enumerate((-1.4, 0, 1.4), 1)
        )
        return f'''(footprint "Zappd:MotorPhasePads" (layer "F.Cu") (at {x} {y}) (attr smd)
  (property "Reference" "{placement.reference}" (at 0 -2) (layer "F.SilkS")
    (effects (font (size 0.8 0.8) (thickness 0.12))))
{pads}
)'''

    model = placement.model
    text = libraries[model]
    text = re.sub(r'^\(footprint "[^"]+"', f'(footprint "{model.library}:{Path(model.footprint_path).stem}"', text)
    text = re.sub(r'^\s*\((?:version|generator|generator_version) [^\n]+\)\n', '', text, flags=re.MULTILINE)
    text = text.replace('(layer "F.Cu")', f'(layer "F.Cu") (at {x} {y})', 1)
    text = text.replace('"Reference" "REF**"', f'"Reference" "{placement.reference}"', 1)
    text = re.sub(r'\(model "[^"]+"', f'(model "${{ZAPPD_KICAD_MODELS}}/{model.step_path}"', text)
    if model == USB_C:
        text = re.sub(
            r'(\(pad "([^"]+)" [^\n]+)(\n\t\t)',
            lambda match: (f'{match[1]} (net "{USB_SHARED_PADS[match[2]]}"){match[3]}'
                           if match[2] in USB_SHARED_PADS else match[0]),
            text,
        )
    return re.sub(
        r'\(uuid "([^"]+)"\)',
        lambda match: f'(uuid "{uuid5(NAMESPACE_URL, f"{board_id}/{placement.reference}/{match[1]}")}")',
        text,
    )


def write_board(board: Board, libraries: dict[Model, str], directory: Path) -> Path:
    path = directory / f"{board.id}.kicad_pcb"
    layers = [
        '(0 "F.Cu" signal)', '(31 "B.Cu" signal)', '(36 "B.SilkS" user "B.Silkscreen")',
        '(37 "F.SilkS" user "F.Silkscreen")', '(38 "B.Mask" user)', '(39 "F.Mask" user)',
        '(35 "F.Paste" user)', '(34 "B.Paste" user)', '(44 "Edge.Cuts" user)',
        '(46 "B.CrtYd" user "B.Courtyard")', '(47 "F.CrtYd" user "F.Courtyard")',
        '(48 "B.Fab" user)', '(49 "F.Fab" user)',
    ]
    lines = [
        '(kicad_pcb (version 20260206) (generator "zappd")',
        f'  (general (thickness {BOARD_THICKNESS_MM}))',
        '  (paper "A4")',
        '  (layers ' + ' '.join(layers) + ')',
        '  (setup (pad_to_mask_clearance 0))',
        '  (gr_rect'
        f' (start {BOARD_ORIGIN_MM - board.width / 2} {BOARD_ORIGIN_MM - board.length / 2})'
        f' (end {BOARD_ORIGIN_MM + board.width / 2} {BOARD_ORIGIN_MM + board.length / 2})'
        ' (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))',
    ]
    if board.mounting_pitch:
        x_pitch, y_pitch = board.mounting_pitch
        diameter = board.mounting_diameter
        for i, (x_sign, y_sign) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1)), 1):
            x = BOARD_ORIGIN_MM + x_sign * x_pitch / 2
            y = BOARD_ORIGIN_MM + y_sign * y_pitch / 2
            lines.append(
                f'  (footprint "Zappd:MountingHole" (layer "F.Cu") (at {x} {y})'
                ' (attr board_only exclude_from_pos_files exclude_from_bom)'
                f' (property "Reference" "H{i}" (at 0 -2.5) (layer "F.Fab")'
                ' (effects (font (size 0.8 0.8) (thickness 0.12))))'
                f' (pad "" np_thru_hole circle (at 0 0) (size {diameter} {diameter})'
                f' (drill {diameter}) (layers "*.Cu" "*.Mask")))'
            )
    lines.extend(board_footprint(footprint, libraries, board.id) for footprint in board.footprints)
    for footprint in board.footprints:
        if footprint.model != USB_C:
            continue
        x = BOARD_ORIGIN_MM + footprint.x
        y = BOARD_ORIGIN_MM + footprint.y
        for net, pad_x, route_y in (("GND", 3.2, -7), ("VBUS", 2.4, -5.5)):
            route = ((-pad_x, -3.68), (-pad_x, route_y), (pad_x, route_y), (pad_x, -3.68))
            for (ax, ay), (bx, by) in zip(route, route[1:]):
                lines.append(
                    f'  (segment (start {x + ax:.4f} {y + ay:.4f}) (end {x + bx:.4f} {y + by:.4f})'
                    f' (width 0.2) (layer "F.Cu") (net "{net}"))'
                )
    lines.append(")")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    project = {
        "meta": {"filename": path.with_suffix(".kicad_pro").name, "version": 1},
        "text_variables": {"ZAPPD_KICAD_MODELS": "${KIPRJMOD}/../../data/cots_library/kicad_3d"},
    }
    if any(footprint.model == USB_C for footprint in board.footprints):
        project["board"] = {"design_settings": {"rules": {"min_hole_clearance": 0.19}}}
    path.with_suffix(".kicad_pro").write_text(json.dumps(project, indent=2) + "\n", encoding="utf-8")
    return path


def center_step(
    source: Path, target: Path, min_colors: int, rotation_x_degrees: float = 0,
) -> tuple[gp_Trsf, Vector, str, int, int]:
    shape, _, _ = read_and_validate_step(source)
    lower, upper = shape_bounds_mm(shape)
    offset = gp_Vec(*(-(low + high) / 2 for low, high in zip(lower, upper)))
    transform = gp_Trsf()
    if rotation_x_degrees:
        transform.SetRotation(gp_Ax1(gp_Pnt(), gp_Dir(1, 0, 0)), math.radians(rotation_x_degrees))
    transform.SetTranslationPart(offset.Transformed(transform))
    placement = TopLoc_Location(transform)
    document = read_xcaf_document(source)
    tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    roots = Sequence_TDF_Label()
    tool.GetFreeShapes(roots)
    for root in roots:
        location = placement.Multiplied(tool.GetLocation_s(root))
        if not tool.SetLocation(root, location, TDF_Label()):
            raise RuntimeError(f"Could not center XCAF root from {source}")
    tool.UpdateAssemblies()

    writer = STEPCAFControl_Writer()
    if not writer.Transfer(document):
        raise RuntimeError(f"Could not transfer XCAF document from {source}")
    header = APIHeaderSection_MakeHeader(writer.ChangeWriter().Model())
    header.SetTimeStamp(TCollection_HAsciiString("2026-01-01T00:00:00"))
    if writer.Write(str(target)) != IFSelect_RetDone:
        raise RuntimeError(f"Could not write {target}")

    stabilize_step_presentation(target)
    centered, digest, face_count = read_and_validate_step(target)
    low, high = shape_bounds_mm(centered)
    if any(not math.isclose(lo + hi, 0, abs_tol=0.0001) for lo, hi in zip(low, high)):
        raise RuntimeError(f"STEP is not centered: {target}")
    colors = {color for _, color in read_xcaf_face_colors(target) if color is not None}
    if len(colors) < min_colors:
        raise RuntimeError(f"Expected at least {min_colors} XCAF colors in {target}, got {len(colors)}")
    dimensions = tuple(round(hi - lo, 4) for lo, hi in zip(low, high))
    return transform, dimensions, digest, face_count, len(colors)


def registry_port(port: Port, point_mm: Vector, exit_direction: Vector | None = None) -> dict:
    x, y, z = point_mm
    dx, dy, dz = exit_direction or port.model_exit
    return {
        "portId": f"port_{port.id}",
        "label": port.label,
        "connectorType": port.connector_type,
        "busKind": port.bus_kind,
        "localPositionMeters": [round(value / 1000, 7) for value in (x, z, -y)],
        "exitDirection": [dx, dz, -dy],
    }


def pad_surface_z(shape, x: float, y: float) -> float:
    heights = []
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        (xmin, ymin, zmin), (xmax, ymax, zmax) = shape_bounds_mm(explorer.Current())
        if (
            math.isclose(zmin, zmax, abs_tol=0.0001)
            and math.isclose((xmin + xmax) / 2, x, abs_tol=0.0001)
            and math.isclose((ymin + ymax) / 2, y, abs_tol=0.0001)
        ):
            heights.append(zmax)
        explorer.Next()
    if not heights:
        raise RuntimeError(f"Missing exported solder pad at ({x}, {y})")
    return max(heights)


def footprint_ports(
    board_file: Path, step_file: Path, footprints: tuple[Footprint, ...], placement: gp_Trsf,
) -> list[dict]:
    placements = {
        reference: (float(x) - BOARD_ORIGIN_MM, BOARD_ORIGIN_MM - float(y))
        for x, y, reference in re.findall(
            r'^\s*\(footprint "[^"]+"\s+\(layer "F.Cu"\) \(at ([\d.]+) ([\d.]+)\)'
            r'(?:(?!^\s*\(footprint).)*?\(property "Reference" "([^"]+)"',
            board_file.read_text(encoding="utf-8"),
            flags=re.MULTILINE | re.DOTALL,
        )
    }
    document = read_xcaf_document(step_file)
    tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    roots = Sequence_TDF_Label()
    tool.GetFreeShapes(roots)
    root = roots.Value(1)
    components = Sequence_TDF_Label()
    tool.GetComponents_s(root, components)
    transforms = {}
    for label in components:
        name = TDataStd_Name()
        if label.FindAttribute(TDataStd_Name.GetID_s(), name):
            transforms[name.Get().ToExtString()] = tool.GetLocation_s(label).Transformation()

    shape = tool.GetShape_s(root)
    ports = []
    for footprint in footprints:
        port = footprint.port
        if port is None:
            continue
        pcb_x, pcb_y = placements[footprint.reference]
        direction = port.model_exit
        if footprint.model is None:
            x, y, z = pcb_x, pcb_y, pad_surface_z(shape, pcb_x, pcb_y)
        else:
            transform = transforms[footprint.reference]
            model_x, model_y = (transform.Value(axis, 4) for axis in (1, 2))
            if not (
                math.isclose(model_x, pcb_x, abs_tol=0.0001)
                and math.isclose(model_y, pcb_y, abs_tol=0.0001)
            ):
                raise RuntimeError(f"KiCad STEP placement disagrees with {footprint.reference} in {board_file}")
            point = gp_Pnt(*port.model_anchor_mm).Transformed(transform)
            vector = gp_Vec(*port.model_exit).Transformed(transform)
            x, y, z = point.X(), point.Y(), point.Z()
            direction = (vector.X(), vector.Y(), vector.Z())
        point = gp_Pnt(x, y, z).Transformed(placement)
        if placement.Form() not in (gp_Identity, gp_Translation):
            vector = gp_Vec(*direction).Transformed(placement)
            direction = (round(vector.X(), 7), round(vector.Y(), 7), round(vector.Z(), 7))
        ports.append(registry_port(port, (point.X(), point.Y(), point.Z()), direction))
    return ports


def build_board(board: Board, libraries: dict[Model, str], work: Path) -> dict:
    path = write_board(board, libraries, work)
    report = REPO_COTS_LIBRARY_DIR / f"{board.id}.drc.json"
    command = subprocess.run(
        (*KICAD, "pcb", "drc", "--format", "json", "--severity-error", "--exit-code-violations",
         "--output", str(report), str(path)),
        check=False,
    )
    drc = json.loads(report.read_text(encoding="utf-8"))
    errors = sum(len(drc[key]) for key in ("violations", "unconnected_items"))
    if command.returncode or errors:
        raise RuntimeError(f"{board.id}: KiCad DRC exit {command.returncode}, {errors} errors ({report})")
    print(f"{board.id}: KiCad DRC exit 0, 0 errors", flush=True)

    raw = work / f"{board.id}.step"
    subprocess.run(
        (*KICAD, "pcb", "export", "step", "--subst-models", "--include-pads", "--include-tracks",
         "--include-soldermask", "--user-origin", f"{BOARD_ORIGIN_MM}x{BOARD_ORIGIN_MM}mm",
         "--define-var", f"ZAPPD_KICAD_MODELS={REPO_COTS_LIBRARY_DIR / 'kicad_3d'}",
         "--output", str(raw), str(path)),
        check=True,
    )
    centered = work / "centered" / raw.name
    placement, dimensions, digest, faces, colors = center_step(
        raw, centered, min_colors=3, rotation_x_degrees=board.rotation_x_degrees,
    )
    print(f"{board.id}: valid BRep, {faces} faces, {colors} XCAF colors", flush=True)
    return {
        "cotsId": board.id,
        "name": board.name,
        "origin": "kicad_pcb_step",
        "spdxLicense": KICAD_MODEL_LICENSE,
        "sourceUrl": f"kicad://zappd/{board.id}",
        "sourceName": f"Zappd {path.name} with KiCad kicad-packages3D models",
        "stepFixtureName": raw.name,
        "expectedStepSha256": digest,
        "dimensionsMm": dimensions,
        "materialHint": "fr4_pcb",
        "colorHex": "#247052",
        "specifications": {
            "pcbWidthMm": board.width,
            "pcbLengthMm": board.length,
            "pcbThicknessMm": BOARD_THICKNESS_MM,
            "brepFaces": faces,
            "xcafColors": colors,
            "referenceLayout": True,
        },
        "ports": footprint_ports(path, raw, board.footprints, placement),
    }


def build_battery(work: Path) -> dict:
    raw = REPO_COTS_LIBRARY_DIR / "upstream" / "3_Battery_Holder_With_Batteries.step"
    pinned_download(
        BATTERY_SOURCE, raw, BATTERY_SHA256,
        BATTERY_SOURCE.replace("/main/", "/1626f92986822050eb3a6232f536b564801d6426/"),
    )
    cots_id = "cots_battery_3s_18650"
    centered = work / "centered" / f"{cots_id}.step"
    _, dimensions, digest, faces, colors = center_step(raw, centered, min_colors=2)
    if dimensions != (77.98, 59.63, 24.74) or faces != 498:
        raise RuntimeError(f"Unexpected 3S battery geometry: {dimensions}, {faces} faces")
    print(f"{cots_id}: valid BRep, {faces} faces, {colors} XCAF colors", flush=True)
    return {
        "cotsId": cots_id,
        "name": "3S 18650 battery holder with cells",
        "origin": "cots_library_step",
        "spdxLicense": "NOASSERTION",
        "sourceUrl": BATTERY_SOURCE,
        "sourceName": "robotjaol/custom-components 3 Battery Holder With Batteries.step",
        "stepFixtureName": centered.name,
        "expectedStepSha256": digest,
        "dimensionsMm": dimensions,
        "materialHint": "li_ion_battery",
        "colorHex": "#3f3f46",
        "specifications": {"seriesCells": 3, "cellFormat": "18650", "brepFaces": faces, "xcafColors": colors},
        "ports": battery_terminal_ports(centered),
    }


def battery_terminal_ports(step_path: Path) -> list[dict]:
    shape, _, _ = read_and_validate_step(step_path)
    bottom = shape_bounds_mm(shape)[0][2]
    tabs = []
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        (xmin, ymin, _), (xmax, ymax, zmax) = shape_bounds_mm(explorer.Current())
        if math.isclose(zmax, bottom, abs_tol=0.0001):
            tabs.append(((xmin + xmax) / 2, (ymin + ymax) / 2, bottom))
        explorer.Next()
    if len(tabs) != 6:
        raise RuntimeError(f"Expected six contact tabs on the battery holder, got {len(tabs)}")

    ports = []
    for index, anchor in enumerate(sorted(tabs, key=lambda tab: (tab[0] > 0, tab[1])), 1):
        port = Port(f"tab_{index}", f"Battery holder contact {index}", "Solder tab", "dc_power", anchor, (0, 0, -1))
        ports.append(registry_port(port, anchor))
    return ports


def main() -> None:
    footprints = {}
    for model in MODELS:
        fetch_library_file(
            "kicad-packages3D", model.step_path, model.step_sha256, MODEL_REVISION,
            REPO_COTS_LIBRARY_DIR / "kicad_3d" / model.step_path,
        )
        footprints[model] = fetch_library_file(
            "kicad-footprints", model.footprint_path, model.footprint_sha256, FOOTPRINT_REVISION,
            REPO_COTS_LIBRARY_DIR / "kicad_footprints" / model.footprint_path,
        ).decode("utf-8")

    with TemporaryDirectory(prefix="cots-build-", dir=REPO_COTS_LIBRARY_DIR) as directory:
        work = Path(directory)
        (work / "centered").mkdir()
        parts = [build_board(board, footprints, work) for board in BOARDS]
        parts.append(build_battery(work))
        registry_json = subprocess.run(
            ("pnpm", "exec", "prettier", "--stdin-filepath", str(REGISTRY)),
            check=True,
            capture_output=True,
            text=True,
            input=json.dumps(parts),
            cwd=ROOT,
        ).stdout
        for part in parts:
            name = part["stepFixtureName"]
            (work / "centered" / name).replace(REPO_COTS_LIBRARY_DIR / name)
        BOARD_DIR.mkdir(parents=True, exist_ok=True)
        for board in BOARDS:
            for suffix in (".kicad_pcb", ".kicad_pro"):
                name = board.id + suffix
                (work / name).replace(BOARD_DIR / name)
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY.write_text(registry_json, encoding="utf-8")


if __name__ == "__main__":
    main()
