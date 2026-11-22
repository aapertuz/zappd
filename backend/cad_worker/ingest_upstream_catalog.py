from __future__ import annotations

import hashlib
import io
import json
import math
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Builder
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepTools import BRepTools
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Reader, STEPControl_Writer
from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS_Shape
from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Quaternion, gp_Trsf, gp_Vec


REPO_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = REPO_ROOT / "backend" / "data" / "open_step_cache"

DRONE_RAW_BASE = "https://raw.githubusercontent.com/AnupAdhikari64/Drone-CAD/main"
SO100_RAW_BASE = "https://raw.githubusercontent.com/TheRobotStudio/SO-ARM100/main"
NOVA2_RAW_BASE = "https://raw.githubusercontent.com/AstroX-OpenRover/NOVA2/main"


def fetch_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "zappd-cad-ingestor/1.0"})
    with urllib.request.urlopen(req, timeout=60) as response:
        return response.read()


def exact_bounds_mm(shape: Any) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    box.SetGap(0.0)
    cmin = box.CornerMin()
    cmax = box.CornerMax()
    return (cmin.X(), cmin.Y(), cmin.Z()), (cmax.X(), cmax.Y(), cmax.Z())


def count_faces(shape: Any) -> int:
    count = 0
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        count += 1
        exp.Next()
    return count


def center_and_write_step(shape: Any, step_path: Path) -> dict[str, Any]:
    if not BRepCheck_Analyzer(shape).IsValid():
        raise RuntimeError(f"Invalid BRep topology before writing {step_path.name}")

    bmin, bmax = exact_bounds_mm(shape)
    cx = (bmin[0] + bmax[0]) / 2.0
    cy = (bmin[1] + bmax[1]) / 2.0
    cz = (bmin[2] + bmax[2]) / 2.0

    rest_position_m = [
        round(cx / 1000.0, 6),
        round(cz / 1000.0, 6),
        round(-cy / 1000.0, 6),
    ]
    cad_offset_mm = (
        rest_position_m[0] * 1000.0,
        -rest_position_m[2] * 1000.0,
        rest_position_m[1] * 1000.0,
    )
    dims_mm = [
        round(bmax[0] - bmin[0], 2),
        round(bmax[1] - bmin[1], 2),
        round(bmax[2] - bmin[2], 2),
    ]

    trsf = gp_Trsf()
    trsf.SetTranslation(gp_Vec(-cad_offset_mm[0], -cad_offset_mm[1], -cad_offset_mm[2]))
    centered_shape = BRepBuilderAPI_Transform(shape, trsf, True).Shape()

    step_path.parent.mkdir(parents=True, exist_ok=True)
    writer = STEPControl_Writer()
    writer.Transfer(centered_shape, STEPControl_AsIs)
    status = writer.Write(str(step_path))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"Failed to write STEP file: {step_path}")

    sha256_hex = hashlib.sha256(step_path.read_bytes()).hexdigest()
    return {
        "stepFixtureName": step_path.name,
        "dimensionsMm": dims_mm,
        "restPositionMeters": rest_position_m,
        "faceCount": count_faces(centered_shape),
        "stepSha256": sha256_hex,
    }


def read_step_bytes(payload: bytes) -> Any:
    with tempfile.NamedTemporaryFile(suffix=".step") as tf:
        tf.write(payload)
        tf.flush()
        reader = STEPControl_Reader()
        status = reader.ReadFile(tf.name)
        if status != IFSelect_RetDone:
            raise RuntimeError("STEPControl_Reader failed on upstream payload")
        reader.TransferRoots()
        return reader.OneShape()


def ingest_drone_cad(cache_dir: Path) -> dict[str, dict[str, Any]]:
    part_urls = {
        "1.Base.FCStd": f"{DRONE_RAW_BASE}/1.Base.FCStd",
        "2. Hang.FCStd": f"{DRONE_RAW_BASE}/2.%20Hang.FCStd",
        "3. Motor.FCStd": f"{DRONE_RAW_BASE}/3.%20Motor.FCStd",
        "4. Nut.FCStd": f"{DRONE_RAW_BASE}/4.%20Nut.FCStd",
        "5. Propeller.FCStd": f"{DRONE_RAW_BASE}/5.%20Propeller.FCStd",
        "6. Cover.FCStd": f"{DRONE_RAW_BASE}/6.%20Cover.FCStd",
    }
    base_shapes: dict[str, Any] = {}
    for file_key, url in part_urls.items():
        raw = fetch_bytes(url)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            with tempfile.NamedTemporaryFile(suffix=".brp") as tf:
                tf.write(zf.read("Body.Shape.brp"))
                tf.flush()
                shape = TopoDS_Shape()
                BRepTools.Read_s(shape, tf.name, BRep_Builder())
                base_shapes[file_key] = shape

    assembly_bytes = fetch_bytes(f"{DRONE_RAW_BASE}/Drone-Assembly.FCStd")
    placed_by_link: dict[str, Any] = {}
    rot45 = gp_Trsf()
    rot45.SetRotation(gp_Ax1(gp_Pnt(0.0, 0.0, 0.0), gp_Dir(0.0, 0.0, 1.0)), math.pi / 4.0)

    with zipfile.ZipFile(io.BytesIO(assembly_bytes)) as zf:
        doc_xml = zf.read("Document.xml").decode("utf-8", errors="replace")
        root = ET.fromstring(doc_xml)
        for obj in root.findall("./ObjectData/Object"):
            name = obj.attrib.get("name", "")
            if not name.startswith("Part"):
                continue
            pl = obj.find(".//Property[@name='Placement']/PropertyPlacement")
            linked = obj.find(".//Property[@name='LinkedObject']/XLink")
            if pl is None or linked is None:
                continue
            source_file = linked.attrib["file"]
            px = float(pl.attrib["Px"])
            py = float(pl.attrib["Py"])
            pz = float(pl.attrib["Pz"])
            q0 = float(pl.attrib["Q0"])
            q1 = float(pl.attrib["Q1"])
            q2 = float(pl.attrib["Q2"])
            q3 = float(pl.attrib["Q3"])
            trsf = gp_Trsf()
            trsf.SetTransformation(gp_Quaternion(q0, q1, q2, q3), gp_Vec(px, py, pz))
            placed = BRepBuilderAPI_Transform(base_shapes[source_file], trsf, True).Shape()
            placed_by_link[name] = BRepBuilderAPI_Transform(placed, rot45, True).Shape()

    mapping = {
        "Part1_Base": "drone_cad_base_lower.step",
        "Part1_Base001": "drone_cad_base_upper.step",
        "Part2_Hang003": "drone_cad_arm_fl.step",
        "Part2_Hang": "drone_cad_arm_fr.step",
        "Part2_Hang001": "drone_cad_arm_rl.step",
        "Part2_Hang002": "drone_cad_arm_rr.step",
        "Part3_Nut": "drone_cad_standoff_1.step",
        "Part3_Nut001": "drone_cad_standoff_2.step",
        "Part3_Nut002": "drone_cad_standoff_3.step",
        "Part3_Nut003": "drone_cad_standoff_4.step",
        "Part3_Nut004": "drone_cad_standoff_5.step",
        "Part3_Nut005": "drone_cad_standoff_6.step",
        "Part3_Nut006": "drone_cad_standoff_7.step",
        "Part3_Nut007": "drone_cad_standoff_8.step",
        "Part4_Motor003": "drone_cad_motor_fl.step",
        "Part4_Motor": "drone_cad_motor_fr.step",
        "Part4_Motor002": "drone_cad_motor_rl.step",
        "Part4_Motor001": "drone_cad_motor_rr.step",
        "Part5_Propeller": "drone_cad_prop_fl.step",
        "Part5_Propeller003": "drone_cad_prop_fr.step",
        "Part5_Propeller001": "drone_cad_prop_rl.step",
        "Part5_Propeller002": "drone_cad_prop_rr.step",
        "Part6_Cover002": "drone_cad_cover_fl.step",
        "Part6_Cover003": "drone_cad_cover_fr.step",
        "Part6_Cover": "drone_cad_cover_rl.step",
        "Part6_Cover001": "drone_cad_cover_rr.step",
    }

    results: dict[str, dict[str, Any]] = {}
    for link_name, filename in mapping.items():
        results[filename] = center_and_write_step(placed_by_link[link_name], cache_dir / filename)
    return results


def ingest_so100(cache_dir: Path) -> dict[str, dict[str, Any]]:
    payload = fetch_bytes(f"{SO100_RAW_BASE}/STEP/SO100/Follower_Specific/SO_5DOF_ARM100_Assembly.step")
    raw_shape = read_step_bytes(payload)

    rot_x90 = gp_Trsf()
    rot_x90.SetRotation(gp_Ax1(gp_Pnt(0.0, 0.0, 0.0), gp_Dir(1.0, 0.0, 0.0)), math.pi / 2.0)
    zup_shape = BRepBuilderAPI_Transform(raw_shape, rot_x90, True).Shape()

    solids: list[Any] = []
    exp = TopExp_Explorer(zup_shape, TopAbs_SOLID)
    while exp.More():
        solids.append(exp.Current())
        exp.Next()

    if len(solids) != 19:
        raise RuntimeError(f"Expected 19 solids in SO_5DOF_ARM100_Assembly.step, found {len(solids)}")

    press_fit_cuts = [
        (1, 7),
        (5, 8),
        (5, 12),
        (8, 9),
        (8, 11),
        (9, 10),
        (9, 11),
        (11, 16),
        (12, 16),
        (12, 18),
        (13, 17),
    ]
    for target_idx, tool_idx in press_fit_cuts:
        solids[target_idx] = BRepAlgoAPI_Cut(solids[target_idx], solids[tool_idx]).Shape()

    mapping = {
        0: "so100_base_attachment.step",
        1: "so100_base_housing.step",
        2: "so100_motor1_holder.step",
        3: "so100_waveshare_mount.step",
        4: "so100_shoulder_turntable.step",
        5: "so100_shoulder_clip.step",
        6: "so100_passive_horn.step",
        7: "so100_base_servo.step",
        8: "so100_shoulder_servo.step",
        9: "so100_upper_arm_link.step",
        10: "so100_lower_forearm_link.step",
        11: "so100_elbow_clip.step",
        12: "so100_wrist_clevis.step",
        13: "so100_wrist_roll_palm.step",
        14: "so100_moving_jaw.step",
        15: "so100_elbow_servo.step",
        16: "so100_wrist_pitch_servo.step",
        17: "so100_gripper_servo.step",
        18: "so100_wrist_roll_servo.step",
    }

    results: dict[str, dict[str, Any]] = {}
    for idx, filename in mapping.items():
        results[filename] = center_and_write_step(solids[idx], cache_dir / filename)
    return results


def ingest_nova2(cache_dir: Path) -> dict[str, dict[str, Any]]:
    files = {
        "nova2_chassis_plate.step": f"{NOVA2_RAW_BASE}/Assembly/Part%20Studio%201.step",
        "nova2_nano_mount.step": f"{NOVA2_RAW_BASE}/Assembly/Part%20Studio%201%20-%20Nano_mount_Base.step",
        "nova2_connecting_bracket.step": f"{NOVA2_RAW_BASE}/Assembly/ConnectingBracket_012.STEP",
        "nova2_bus_connector.step": f"{NOVA2_RAW_BASE}/Assembly/Connector.step",
        "nova2_wheel_bracket_left.step": f"{NOVA2_RAW_BASE}/Assembly/WheelBracket_000_configs.STEP",
        "nova2_wheel_bracket_right.step": f"{NOVA2_RAW_BASE}/Assembly/WheelBracket_001_configs.STEP",
        "nova2_dynamixel_xl430.step": f"{NOVA2_RAW_BASE}/Assembly/XL-430_new.stp",
        "nova2_flange_coupling.step": f"{NOVA2_RAW_BASE}/Assembly/8mm%20Rigid%20Flange%20Coupling%20v2.step",
        "nova2_zed2i_camera.step": f"{NOVA2_RAW_BASE}/Assembly/ZED%202i%20Narrow.step",
    }

    results: dict[str, dict[str, Any]] = {}
    for filename, url in files.items():
        shape = read_step_bytes(fetch_bytes(url))
        results[filename] = center_and_write_step(shape, cache_dir / filename)
    return results


def main() -> int:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    for stale in CACHE_DIR.glob("*.step"):
        stale.unlink()

    summary = {
        "quadcopter_drone_v1": ingest_drone_cad(CACHE_DIR),
        "robotic_arm_3dof_v1": ingest_so100(CACHE_DIR),
        "open_source_rover_v1": ingest_nova2(CACHE_DIR),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
