from __future__ import annotations

import hashlib
import re
import shutil
from functools import cache
from itertools import count
from pathlib import Path
from typing import Any, Literal, TypedDict

from OCP.BRep import BRep_Builder
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.IFSelect import IFSelect_RetDone
from OCP.Quantity import Quantity_Color, Quantity_TOC_sRGB
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.STEPControl import STEPControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDF import TDF_Label
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Iterator, TopoDS_Shape
from OCP.XCAFDoc import XCAFDoc_ColorGen, XCAFDoc_ColorSurf, XCAFDoc_DocumentTool
from OCP.collections import IndexedMap_TopoDS_Shape, Sequence_TDF_Label


REPO_STEP_CACHE_DIR = Path(__file__).resolve().parents[1] / "data" / "open_step_cache"
REPO_COTS_LIBRARY_DIR = REPO_STEP_CACHE_DIR.with_name("cots_library")
MIN_CAD_BREP_FACES = 4
STEP_PRESENTATION = "MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION("
STEP_PRESENTATION_START = re.compile(rf"^#(\d+) = {STEP_PRESENTATION[:-1]}\(", re.MULTILINE)
STEP_ENTITY = re.compile(r"^#(\d+) = ", re.MULTILINE)
STEP_TOKENS = re.compile(r"'(?:[^']|'')*'|#(\d+)|\s+")
STEP_OCCURRENCE = re.compile(r"(?<=NEXT_ASSEMBLY_USAGE_OCCURRENCE\()'\d+'")
STEP_OCCURRENCE_RECORD = re.compile(r"^#\d+ = NEXT_ASSEMBLY_USAGE_OCCURRENCE\([^;]+\);", re.MULTILINE)
STEP_PRESENTATION_ITEMS = re.compile(r"(?<=,\()#\d+(?:,#\d+)*(?=\),#\d+\);$)")


class GeometryOriginPolicy(TypedDict):
    allowedUriPrefixes: tuple[str, ...]
    targetVerifiedStatus: Literal["sourced_verified", "composed_validated"]


GEOMETRY_ORIGIN_POLICY: dict[str, GeometryOriginPolicy] = {
    "open_step_catalog": {
        "allowedUriPrefixes": ("https://",),
        "targetVerifiedStatus": "sourced_verified",
    },
    "cots_library_step": {
        "allowedUriPrefixes": ("https://",),
        "targetVerifiedStatus": "sourced_verified",
    },
    "kicad_pcb_step": {
        "allowedUriPrefixes": ("https://", "kicad://"),
        "targetVerifiedStatus": "composed_validated",
    },
    "procedural_harness": {
        "allowedUriPrefixes": ("https://", "harness://"),
        "targetVerifiedStatus": "composed_validated",
    },
    "parametric_cad": {
        "allowedUriPrefixes": ("https://", "parametric://"),
        "targetVerifiedStatus": "composed_validated",
    },
}


def count_brep_faces(shape: Any) -> int:
    count = 0
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        count += 1
        explorer.Next()
    return count


def stabilize_step_occurrences(source: str) -> str:
    occurrence_ids = count(1)
    source = STEP_OCCURRENCE.sub(lambda _: f"'{next(occurrence_ids)}'", source)

    def join_short_occurrence(match: re.Match[str]) -> str:
        record = match[0].replace("\n  ", "")
        return record if len(record) < 72 else match[0]

    return STEP_OCCURRENCE_RECORD.sub(join_short_occurrence, source)


def stabilize_step_presentation(path: Path) -> None:
    source = path.read_text(encoding="ascii")
    presentation = STEP_PRESENTATION_START.search(source)
    if presentation is None:
        raise RuntimeError(f"Missing STEP presentation records in {path}")
    first_style = int(presentation[1])
    geometry = stabilize_step_occurrences(source[:presentation.start()])
    if any(int(match[1]) >= first_style for match in re.finditer(r"#(\d+)", geometry)):
        raise RuntimeError(f"STEP geometry references presentation entities in {path}")

    styles, ending = source[presentation.start():].split("ENDSEC;", 1)
    fields = STEP_ENTITY.split(styles)
    entities = {
        int(number): STEP_TOKENS.sub(lambda token: "" if token[0].isspace() else token[0], expression)
        for number, expression in zip(fields[1::2], fields[2::2])
    }
    roots = [number for number, expression in entities.items() if expression.startswith(STEP_PRESENTATION)]

    @cache
    def style_key(number: int) -> str:
        return STEP_TOKENS.sub(
            lambda token: style_key(int(token[1])) if token[1] and int(token[1]) >= first_style else token[0],
            entities[number],
        )

    for root in roots:
        entities[root] = STEP_PRESENTATION_ITEMS.sub(
            lambda items: ",".join(sorted(items[0].split(","), key=lambda item: style_key(int(item[1:])))),
            entities[root],
        )

    numbers_by_style: dict[str, int] = {}
    ordered_styles: dict[int, str] = {}
    reached: set[int] = set()

    def renumber(number: int) -> int:
        if number < first_style:
            return number
        reached.add(number)
        key = style_key(number)
        if key in numbers_by_style:
            return numbers_by_style[key]
        stable_number = first_style + len(numbers_by_style)
        numbers_by_style[key] = stable_number
        ordered_styles[stable_number] = STEP_TOKENS.sub(
            lambda token: f"#{renumber(int(token[1]))}" if token[1] else token[0],
            entities[number],
        )
        return stable_number

    for root in sorted(roots, key=style_key):
        renumber(root)
    if {style_key(number) for number in entities.keys() - reached} - numbers_by_style.keys():
        raise RuntimeError(f"Unreferenced STEP presentation entities in {path}")

    def wrap_items(items: re.Match[str]) -> str:
        references = items[0].split(",")
        return ",\n  ".join(",".join(references[start:start + 12]) for start in range(0, len(references), 12))

    lines = [
        f"#{number} = {STEP_PRESENTATION_ITEMS.sub(wrap_items, expression)}\n"
        for number, expression in sorted(ordered_styles.items())
    ]
    path.write_text(geometry + "".join(lines) + "ENDSEC;" + ending, encoding="ascii")


def read_xcaf_document(step_path: Path) -> TDocStd_Document:
    document = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    reader = STEPCAFControl_Reader()
    reader.SetColorMode(True)
    if reader.ReadFile(str(step_path)) != IFSelect_RetDone or not reader.Transfer(document):
        raise RuntimeError(f"STEPCAFControl_Reader failed on {step_path}")
    return document


def xcaf_shape(document: TDocStd_Document) -> TopoDS_Shape:
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    roots = Sequence_TDF_Label()
    shape_tool.GetFreeShapes(roots)
    if roots.Length() == 1:
        return shape_tool.GetShape_s(roots.Value(1))
    shape = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(shape)
    for root in roots:
        builder.Add(shape, shape_tool.GetShape_s(root))
    return shape


def read_xcaf_face_colors(step_path: Path) -> list[tuple[Any, str | None]]:
    document = read_xcaf_document(step_path)
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    color_tool = XCAFDoc_DocumentTool.ColorTool_s(document.Main())
    faces: list[tuple[Any, str | None]] = []

    def label_color(label: TDF_Label) -> str | None:
        color = Quantity_Color()
        for color_type in (XCAFDoc_ColorSurf, XCAFDoc_ColorGen):
            if color_tool.GetColor_s(label, color_type, color):
                return "#" + "".join(f"{round(channel * 255):02x}" for channel in color.Values(Quantity_TOC_sRGB))
        return None

    def visit_label(label: TDF_Label, location: TopLoc_Location, inherited: str | None) -> None:
        color = label_color(label) or inherited
        referred = TDF_Label()
        if shape_tool.GetReferredShape_s(label, referred):
            visit_label(referred, location.Multiplied(shape_tool.GetLocation_s(label)), color)
            return

        components = Sequence_TDF_Label()
        if shape_tool.GetComponents_s(label, components):
            for child in components:
                visit_label(child, location, color)
            return

        subshapes = Sequence_TDF_Label()
        shape_tool.GetSubShapes_s(label, subshapes)
        styled_shapes = IndexedMap_TopoDS_Shape()
        colors: dict[int, str] = {}
        for subshape in subshapes:
            subshape_color = label_color(subshape)
            if subshape_color is not None:
                colors[styled_shapes.Add(shape_tool.GetShape_s(subshape))] = subshape_color

        def visit_shape(shape: Any, parent_color: str | None) -> None:
            shape_color = colors.get(styled_shapes.FindIndex(shape), parent_color)
            if shape.ShapeType() == TopAbs_FACE:
                faces.append((TopoDS.Face(shape.Moved(location)), shape_color))
                return
            children = TopoDS_Iterator(shape)
            while children.More():
                visit_shape(children.Value(), shape_color)
                children.Next()

        shape = shape_tool.GetShape_s(label)
        if not shape.IsNull():
            visit_shape(shape, color)

    roots = Sequence_TDF_Label()
    shape_tool.GetFreeShapes(roots)
    for root in roots:
        visit_label(root, TopLoc_Location(), None)
    return faces


def read_and_validate_step(
    step_path: Path,
    expected_sha256: str | None = None,
) -> tuple[Any, str, int]:
    if not step_path.exists():
        raise FileNotFoundError(f"Missing verified upstream STEP file: {step_path}")

    raw_bytes = step_path.read_bytes()
    if b"ISO-10303-21;" not in raw_bytes[:256]:
        raise RuntimeError(f"Invalid STEP header in {step_path}")

    sha256_hex = hashlib.sha256(raw_bytes).hexdigest()
    if expected_sha256 is not None and sha256_hex != expected_sha256:
        raise RuntimeError(
            f"STEP SHA-256 mismatch for {step_path.name}: expected {expected_sha256}, got {sha256_hex}"
        )

    reader = STEPControl_Reader()
    status = reader.ReadFile(str(step_path))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"STEPControl_Reader failed on {step_path}")
    reader.TransferRoots()
    shape = reader.OneShape()

    if not BRepCheck_Analyzer(shape).IsValid():
        raise RuntimeError(f"BRepCheck_Analyzer invalid topology in {step_path}")

    face_count = count_brep_faces(shape)
    if face_count < MIN_CAD_BREP_FACES:
        raise RuntimeError(
            f"Insufficient geometric detail in {step_path.name}: {face_count} faces < {MIN_CAD_BREP_FACES}"
        )

    return shape, sha256_hex, face_count


def node_provenance_failure(
    node_spec: dict[str, Any], policy: GeometryOriginPolicy
) -> str | None:
    source_url = node_spec.get("sourceUrl")
    if not isinstance(source_url, str) or not source_url.startswith(policy["allowedUriPrefixes"]):
        return f"Node {node_spec['id']} has disallowed sourceUrl for origin {node_spec['origin']}"
    spdx_license = node_spec.get("spdxLicense")
    if not isinstance(spdx_license, str) or not spdx_license.strip():
        return f"Node {node_spec['id']} lacks SPDX license identifier"
    return None


def resolve_component_step(node_spec: dict[str, Any], cache_dir: Path) -> dict[str, Any]:
    origin = node_spec.get("origin")
    if not isinstance(origin, str) or origin not in GEOMETRY_ORIGIN_POLICY:
        raise RuntimeError(f"Node {node_spec['id']} uses disallowed origin {origin!r}")

    policy = GEOMETRY_ORIGIN_POLICY[origin]
    provenance_failure = node_provenance_failure(node_spec, policy)
    fixture_name = node_spec.get("stepFixtureName")
    if fixture_name is None:
        return {
            "hasGeometry": False,
            "provenanceFailure": provenance_failure,
            "targetVerifiedStatus": policy["targetVerifiedStatus"],
        }
    if provenance_failure is not None:
        raise RuntimeError(provenance_failure)

    cache_dir.mkdir(parents=True, exist_ok=True)
    step_path = cache_dir / str(fixture_name)
    if not step_path.exists():
        for fixture_dir in (REPO_STEP_CACHE_DIR, REPO_COTS_LIBRARY_DIR):
            repo_step_path = fixture_dir / str(fixture_name)
            if repo_step_path.is_file():
                step_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(repo_step_path, step_path)
                break

    shape, sha256_hex, face_count = read_and_validate_step(
        step_path,
        expected_sha256=node_spec.get("expectedStepSha256"),
    )

    return {
        "hasGeometry": True,
        "shape": shape,
        "stepPath": step_path,
        "sha256": sha256_hex,
        "faceCount": face_count,
        "initialStatus": "unverified",
        "targetVerifiedStatus": policy["targetVerifiedStatus"],
    }
