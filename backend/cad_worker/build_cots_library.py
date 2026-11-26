from __future__ import annotations

import hashlib
import json
import math
import re
import subprocess
from dataclasses import dataclass, replace
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
SPEC_DIR = REGISTRY.parent / "specs"
KICAD = ("uvx", "--from", "kicode-pcb==10.99.0.dev20261106", "kicad-cli")
LIBRARIES = "https://gitlab.com/kicad/libraries"
BOARD_ORIGIN_MM = 100
BOARD_THICKNESS_MM = 1.6
USB_SHARED_PADS = {
    "A1": "GND", "B12": "GND",
    "A12": "GND", "B1": "GND",
    "A4": "VBUS", "B9": "VBUS",
    "A9": "VBUS", "B4": "VBUS",
}


Vector = tuple[float, float, float]


@dataclass(frozen=True)
class Model:
    library: str
    name: str
    footprint_name: str
    step_sha256: str
    footprint_sha256: str
    model_revision: str
    footprint_revision: str
    spdx_license: str

    @property
    def step_path(self) -> str:
        return f"{self.library}.3dshapes/{self.name}.step"

    @property
    def footprint_path(self) -> str:
        return f"{self.library}.pretty/{self.footprint_name}.kicad_mod"

    @property
    def uses_shared_usb_pads(self) -> bool:
        return self.name.startswith("USB_C_Receptacle_GCT_USB4105-")


@dataclass(frozen=True)
class Port:
    fields: dict
    model_anchor_mm: Vector
    model_exit: Vector


@dataclass(frozen=True)
class Footprint:
    reference: str
    x: float
    y: float
    model: Model | None
    port: Port | None


@dataclass(frozen=True)
class Board:
    id: str
    name: str
    width: float
    length: float
    rotation_x_degrees: float
    category: str
    tags: list[str]
    mounting_interfaces: list[dict]
    footprints: tuple[Footprint, ...]
    include_soldermask: bool = True

    @property
    def drill_patterns(self) -> list[dict]:
        return [
            mount for mount in self.mounting_interfaces
            if mount["kind"].endswith("_standoff") and "boltPitchMm" in mount
        ]


def load_cots_specs(directory: Path = SPEC_DIR) -> tuple[dict[str, Model], tuple[Board, ...], list[dict]]:
    def read(name: str):
        return json.loads((directory / f"{name}.json").read_text(encoding="utf-8"))

    models = {
        key: Model(
            library=spec["library"],
            name=spec["name"],
            footprint_name=spec["footprintName"],
            step_sha256=spec["stepSha256"],
            footprint_sha256=spec["footprintSha256"],
            model_revision=spec["modelRevision"],
            footprint_revision=spec["footprintRevision"],
            spdx_license=spec["spdxLicense"],
        )
        for key, spec in read("kicad_models").items()
    }

    def footprint(placement: dict) -> Footprint:
        connector = None
        if "port" in placement:
            fields = dict(placement["port"])
            anchor = tuple(fields.pop("modelAnchorMm"))
            exit_direction = tuple(fields.pop("modelExitDirection"))
            connector = Port(fields, anchor, exit_direction)
        model = placement["model"]
        return Footprint(
            placement["reference"], placement["xMm"], placement["yMm"],
            None if model == "motor_phase_pads" else models[model], connector,
        )

    boards = tuple(
        Board(
            id=spec["cotsId"],
            name=spec["name"],
            width=spec["widthMm"],
            length=spec["lengthMm"],
            rotation_x_degrees=spec["rotationXDegrees"],
            category=spec["category"],
            tags=spec["tags"],
            mounting_interfaces=spec["mountingInterfaces"],
            footprints=tuple(footprint(placement) for placement in spec["footprints"]),
            include_soldermask=spec.get("includeSoldermask", True),
        )
        for spec in read("kicad_boards")
    )
    return models, boards, read("upstream_cots")


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
    return pinned_download(f"{base}/{revision}/{path}", destination, digest)


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
    if model.uses_shared_usb_pads:
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
    hole_number = 0
    for mount in board.drill_patterns:
        x_pitch, y_pitch = mount["boltPitchMm"]
        diameter = mount["holeDiameterMm"]
        for x_sign, y_sign in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            hole_number += 1
            x = BOARD_ORIGIN_MM + x_sign * x_pitch / 2
            y = BOARD_ORIGIN_MM + y_sign * y_pitch / 2
            lines.append(
                f'  (footprint "Zappd:MountingHole" (layer "F.Cu") (at {x} {y})'
                ' (attr board_only exclude_from_pos_files exclude_from_bom)'
                f' (property "Reference" "H{hole_number}" (at 0 -2.5) (layer "F.Fab")'
                ' (effects (font (size 0.8 0.8) (thickness 0.12))))'
                f' (pad "" np_thru_hole circle (at 0 0) (size {diameter} {diameter})'
                f' (drill {diameter}) (layers "*.Cu" "*.Mask")))'
            )
    lines.extend(board_footprint(footprint, libraries, board.id) for footprint in board.footprints)
    for footprint in board.footprints:
        if footprint.model is None or not footprint.model.uses_shared_usb_pads:
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
    if any(footprint.model and footprint.model.uses_shared_usb_pads for footprint in board.footprints):
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
        **port.fields,
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
    report = work / f"{board.id}.drc.json"
    command = subprocess.run(
        (*KICAD, "pcb", "drc", "--format", "json", "--severity-error", "--exit-code-violations",
         "--output", str(report), str(path)),
        check=False,
    )
    drc = json.loads(report.read_text(encoding="utf-8"))
    errors = sum(len(drc[key]) for key in ("violations", "unconnected_items"))
    if command.returncode or errors:
        raise RuntimeError(f"{board.id}: KiCad DRC exit {command.returncode}, {errors} errors: {drc}")
    print(f"{board.id}: KiCad DRC exit 0, 0 errors", flush=True)

    raw = work / f"{board.id}.step"
    soldermask = ("--include-soldermask",) if board.include_soldermask else ()
    subprocess.run(
        (*KICAD, "pcb", "export", "step", "--subst-models", "--include-pads", "--include-tracks",
         *soldermask, "--user-origin", f"{BOARD_ORIGIN_MM}x{BOARD_ORIGIN_MM}mm",
         "--define-var", f"ZAPPD_KICAD_MODELS={REPO_COTS_LIBRARY_DIR / 'kicad_3d'}",
         "--output", str(raw), str(path)),
        check=True,
    )
    centered = work / "centered" / raw.name
    placement, dimensions, digest, faces, colors = center_step(
        raw, centered, min_colors=3, rotation_x_degrees=board.rotation_x_degrees,
    )
    licenses = {footprint.model.spdx_license for footprint in board.footprints if footprint.model is not None}
    print(f"{board.id}: valid BRep, {faces} faces, {colors} XCAF colors, SHA-256 {digest}", flush=True)
    return {
        "cotsId": board.id,
        "name": board.name,
        "origin": "kicad_pcb_step",
        "spdxLicense": " AND ".join(sorted(licenses)),
        "sourceUrl": f"kicad://zappd/{board.id}",
        "sourceName": f"Zappd {path.name} with KiCad kicad-packages3D models",
        "stepFixtureName": raw.name,
        "expectedStepSha256": digest,
        "dimensionsMm": dimensions,
        "materialHint": "fr4_pcb",
        "colorHex": "#247052",
        "category": board.category,
        "tags": board.tags,
        "mountingInterfaces": board.mounting_interfaces,
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


def build_upstream_part(spec: dict, work: Path) -> dict:
    raw = REPO_COTS_LIBRARY_DIR / "upstream" / spec["sourceFileName"]
    pinned_download(spec["sourceUrl"], raw, spec["expectedUpstreamSha256"], spec["fallbackUrl"])
    cots_id = spec["cotsId"]
    centered = work / "centered" / f"{cots_id}.step"
    _, dimensions, digest, faces, colors = center_step(raw, centered, min_colors=spec["minXcafColors"])
    if dimensions != tuple(spec["expectedDimensionsMm"]) or faces != spec["expectedFaceCount"]:
        raise RuntimeError(f"{cots_id}: unexpected geometry: {dimensions}, {faces} faces")
    print(f"{cots_id}: valid BRep, {faces} faces, {colors} XCAF colors, SHA-256 {digest}", flush=True)
    return {
        **{key: spec[key] for key in (
            "cotsId", "name", "spdxLicense", "sourceUrl", "sourceName", "materialHint", "colorHex",
            "category", "tags", "mountingInterfaces",
        )},
        "origin": "cots_library_step",
        "stepFixtureName": centered.name,
        "expectedStepSha256": digest,
        "dimensionsMm": dimensions,
        "specifications": {**spec["specifications"], "brepFaces": faces, "xcafColors": colors},
        "ports": upstream_ports(centered, spec["terminalLayout"]),
    }


def upstream_ports(step_path: Path, layout: dict) -> list[dict]:
    if layout["kind"] != "bottom_tabs":
        raise ValueError(f"Unsupported terminal layout: {layout['kind']}")
    shape, _, _ = read_and_validate_step(step_path)
    bottom = shape_bounds_mm(shape)[0][2]
    tabs = []
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        (xmin, ymin, _), (xmax, ymax, zmax) = shape_bounds_mm(explorer.Current())
        if math.isclose(zmax, bottom, abs_tol=0.0001):
            tabs.append(((xmin + xmax) / 2, (ymin + ymax) / 2, bottom))
        explorer.Next()
    if len(tabs) != layout["count"]:
        raise RuntimeError(f"{step_path}: expected {layout['count']} contact tabs, got {len(tabs)}")

    anchors = sorted(tabs, key=lambda tab: (tab[0] > 0, tab[1]))
    ports = []
    for index, anchor in enumerate(anchors, 1):
        port = Port({
            "portId": f"port_tab_{index}",
            "label": f"Battery holder contact {index}",
            "connectorType": "Solder tab",
            "busKind": "dc_power",
            **layout["tabRating"],
        }, anchor, (0, 0, -1))
        ports.append(registry_port(port, anchor))
    for declared_port in layout["ports"]:
        fields = dict(declared_port)
        anchor_index = fields.pop("anchorTab")
        if not 1 <= anchor_index <= len(anchors):
            raise ValueError(f"{step_path}: missing contact tab {anchor_index}")
        anchor = anchors[anchor_index - 1]
        ports.append(registry_port(Port(fields, anchor, (0, 0, -1)), anchor))
    return ports


def main() -> None:
    models, boards, upstream_parts = load_cots_specs()
    footprints = {}
    for model in models.values():
        fetch_library_file(
            "kicad-packages3D", model.step_path, model.step_sha256, model.model_revision,
            REPO_COTS_LIBRARY_DIR / "kicad_3d" / model.step_path,
        )
        footprints[model] = fetch_library_file(
            "kicad-footprints", model.footprint_path, model.footprint_sha256, model.footprint_revision,
            REPO_COTS_LIBRARY_DIR / "kicad_footprints" / model.footprint_path,
        ).decode("utf-8")

    with TemporaryDirectory(prefix="cots-build-", dir=REPO_COTS_LIBRARY_DIR) as directory:
        work = Path(directory)
        (work / "centered").mkdir()
        parts = [build_board(board, footprints, work) for board in boards]
        parts.extend(build_upstream_part(spec, work) for spec in upstream_parts)
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
        for board in boards:
            (work / f"{board.id}.drc.json").replace(REPO_COTS_LIBRARY_DIR / f"{board.id}.drc.json")
            for suffix in (".kicad_pcb", ".kicad_pro"):
                name = board.id + suffix
                (work / name).replace(BOARD_DIR / name)
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY.write_text(registry_json, encoding="utf-8")


if __name__ == "__main__":
    main()
