from __future__ import annotations

import hashlib
import os
import urllib.request
from pathlib import Path
from typing import Any

import build123d as bd
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Reader, STEPControl_Writer
from OCP.IFSelect import IFSelect_RetDone
from OCP.gp import gp_Ax1, gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf


def _make_centered_box(width: float, length: float, height: float):
    return BRepPrimAPI_MakeBox(
        gp_Pnt(-width / 2.0, -length / 2.0, -height / 2.0),
        width,
        length,
        height,
    ).Shape()


def _make_centered_cylinder(radius: float, height: float):
    return BRepPrimAPI_MakeCylinder(
        gp_Ax2(gp_Pnt(0.0, 0.0, -height / 2.0), gp_Dir(0.0, 0.0, 1.0)),
        radius,
        height,
    ).Shape()


def _rotate_z_deg(shape, angle_deg: float):
    if abs(angle_deg) < 1e-6:
        return shape
    trsf = gp_Trsf()
    trsf.SetRotation(gp_Ax1(gp_Pnt(0.0, 0.0, 0.0), gp_Dir(0.0, 0.0, 1.0)), angle_deg * 3.141592653589793 / 180.0)
    return BRepBuilderAPI_Transform(shape, trsf, True).Shape()


def build_parametric_shape(geometry_spec: dict[str, Any]):
    kind = geometry_spec["kind"]
    params = geometry_spec["parametersMm"]

    if kind == "plate_x":
        return _make_centered_box(params["width"], params["length"], params["height"])
    if kind == "arm_boom":
        box = _make_centered_box(params["length"], params["width"], params["height"])
        return _rotate_z_deg(box, params.get("angleDeg", 0.0))
    if kind == "motor_can":
        return _make_centered_cylinder(params["radius"], params["height"])
    if kind == "propeller_blade":
        with bd.BuildPart() as builder:
            bd.Box(params["diameter"], params["chord"], params["thickness"])
            bd.Cylinder(radius=4.5, height=params["thickness"] + 2.0)
        return _rotate_z_deg(builder.part.wrapped, params.get("yawDeg", 0.0))
    if kind == "pcb_board":
        return _make_centered_box(params["width"], params["length"], params["height"])
    if kind == "battery_pack":
        return _make_centered_box(params["width"], params["length"], params["height"])
    if kind == "pedestal_base":
        return _make_centered_cylinder(params["radius"], params["height"])
    if kind == "turntable_ring":
        return _make_centered_cylinder(params["radius"], params["height"])
    if kind == "servo_housing":
        return _make_centered_box(params["width"], params["length"], params["height"])
    if kind == "arm_link":
        return _make_centered_box(params["width"], params["length"], params["height"])
    if kind == "gripper_body":
        with bd.BuildPart() as builder:
            bd.Box(params["width"], params["length"], params["height"])
        return builder.part.wrapped
    if kind == "gripper_jaw":
        with bd.BuildPart() as builder:
            bd.Box(params["width"], params["length"], params["height"])
        return builder.part.wrapped

    raise ValueError(f"Unsupported CAD geometry kind: {kind}")


def write_step_file(shape, step_path: Path) -> str:
    step_path.parent.mkdir(parents=True, exist_ok=True)
    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_AsIs)
    status = writer.Write(str(step_path))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"Failed to write STEP file: {step_path}")
    return hashlib.sha256(step_path.read_bytes()).hexdigest()


def read_and_validate_step(step_path: Path):
    reader = STEPControl_Reader()
    status = reader.ReadFile(str(step_path))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"STEPControl_Reader failed on {step_path}")
    reader.TransferRoots()
    shape = reader.OneShape()
    if not BRepCheck_Analyzer(shape).IsValid():
        raise RuntimeError(f"BRepCheck_Analyzer invalid topology in {step_path}")
    sha256_hex = hashlib.sha256(step_path.read_bytes()).hexdigest()
    return shape, sha256_hex


def resolve_component_step(node_spec: dict[str, Any], cache_dir: Path) -> dict[str, Any]:
    origin = node_spec["origin"]
    geometry_spec = node_spec.get("geometrySpec")
    if geometry_spec is None:
        return {"hasGeometry": False}

    cache_dir.mkdir(parents=True, exist_ok=True)
    fixture_name = node_spec.get("stepFixtureName")

    if origin == "open_step_catalog":
        step_name = fixture_name or f"{node_spec['id']}.step"
        step_path = cache_dir / step_name
        if not step_path.exists():
            fetched = False
            if os.environ.get("ZAPPD_FETCH_UPSTREAM_STEP") == "1":
                source_url = node_spec.get("sourceUrl", "")
                if source_url.startswith("http"):
                    try:
                        with urllib.request.urlopen(source_url, timeout=2.0) as response:
                            payload = response.read()
                        if b"ISO-10303-21;" in payload:
                            step_path.write_bytes(payload)
                            fetched = True
                    except Exception:
                        fetched = False
            if not fetched:
                shape = build_parametric_shape(geometry_spec)
                write_step_file(shape, step_path)
        shape, sha256_hex = read_and_validate_step(step_path)
        return {
            "hasGeometry": True,
            "shape": shape,
            "stepPath": step_path,
            "sha256": sha256_hex,
            "initialStatus": "unverified",
            "targetVerifiedStatus": "sourced_verified",
        }

    synthesized_path = cache_dir / f"fallback_{node_spec['id']}.step"
    raw_shape = build_parametric_shape(geometry_spec)
    write_step_file(raw_shape, synthesized_path)
    shape, sha256_hex = read_and_validate_step(synthesized_path)
    return {
        "hasGeometry": True,
        "shape": shape,
        "stepPath": synthesized_path,
        "sha256": sha256_hex,
        "initialStatus": "unverified",
        "targetVerifiedStatus": "synthesized_verified",
    }
