from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path
from statistics import median
from time import perf_counter

import numpy as np
import pytest
from OCP.BRep import BRep_Builder
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.TDF import TDF_Label
from OCP.TDataStd import TDataStd_Name
from OCP.TopoDS import TopoDS_Solid
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.collections import Sequence_TDF_Label
from OCP.gp import gp_Pnt
from PIL import Image
from pygltflib import GLTF2

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import xbf_cache
from adapter_sandbox import DockerContainerSandboxRunner, LocalOsSandboxRunner
from benchmark_pipeline import worker
from cad_pose import place_shape
from cable_router import CableRoutingBlockedError, _auto_route_bundle
from catalog_ingestor import REPO_COTS_LIBRARY_DIR, read_and_validate_step, read_xcaf_document, resolve_component_step
from catalog_specs import CATALOG_SPECS
from geometry_pipeline import parse_usdz_prim_paths, run_cad_pipeline, shape_bounds_mm
from parametric_multirotor import materialize_multirotor
from routing_paths import RoutingSpace, routing_boxes, voxel_path
from xbf_cache import CadAssetCache


_MULTIROTOR = "parametric_multirotor_v1"
_HEX_PARAMETERS = {"rotor_count": 6, "wheelbase_mm": 320, "deck_gap_mm": 30, "arm_thickness_mm": 5.0}
_BRACKET = """
from build123d import Box, Pos

def build_part(params):
    width = params.get("width", 12)
    base = Box(width, 6, 2)
    flange = Pos(-width / 2 + 1, 0, 3) * Box(2, 6, 4)
    return base + flange
"""


def assert_verified(result: dict) -> None:
    validation = result["validation"]
    assert validation["valid"], validation["failures"]
    assert validation["interferenceCount"] == 0
    assert validation["connectivityValid"]
    assert validation["floatingComponentIds"] == []
    assert validation["electricalValid"]
    assert validation["nodeMappingComplete"]
    assert result["verificationStatus"] == "composed_validated"


def assert_render(path: Path) -> None:
    with Image.open(path) as frame:
        assert frame.format == "PNG"
        assert frame.size == (1200, 900)
        pixels = np.asarray(frame.convert("RGB"))
    for left, top in ((0, 0), (600, 0), (0, 450), (600, 450)):
        assert np.std(pixels[top:top + 450, left:left + 600], axis=(0, 1)).max() > 5


@pytest.fixture(scope="module")
def multirotor_builds(tmp_path_factory: pytest.TempPathFactory) -> dict[int, tuple[dict, Path, Path]]:
    root = tmp_path_factory.mktemp("multirotor")
    steps = root / "steps"
    outputs = {}
    with worker(root / "xbf") as call:
        ping = call(cmd="ping")
        assert ping["id"] == "benchmark"
        assert ping["pid"] > 0
        options = {"archetypeId": _MULTIROTOR, "cacheDir": str(steps)}
        default_out = root / "quad"
        default_result = call(cmd="build", outputDir=str(default_out), renderViewsDir=str(root / "quad-views"), **options)["result"]
        assert default_result["validation"]["buildTimingMs"]["cacheMode"] == "cold_step"
        assert_render(Path(default_result["validation"]["visualRenderPaths"][0]))
        outputs[4] = default_result, default_out, steps

        hex_out = root / "hex"
        hex_result = call(
            cmd="rebuild_params", outputDir=str(hex_out), parameterValues=_HEX_PARAMETERS,
            renderViewsDir=str(root / "hex-views"), **options,
        )["result"]
        assert hex_result["validation"]["buildTimingMs"]["cacheMode"] == "warm_ram"
        assert_render(Path(hex_result["validation"]["visualRenderPaths"][0]))
        outputs[6] = hex_result, hex_out, steps
    return outputs


def _step_component(path: Path, component_id: str):
    document = read_xcaf_document(path)
    tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    labels = Sequence_TDF_Label()
    tool.GetFreeShapes(labels)
    components = Sequence_TDF_Label()
    tool.GetComponents_s(labels.Value(1), components)
    for instance in components:
        definition = TDF_Label()
        if not tool.GetReferredShape_s(instance, definition):
            continue
        name = TDataStd_Name()
        if definition.FindAttribute(TDataStd_Name.GetID_s(), name) and name.Get().ToExtString() == component_id:
            return tool.GetShape_s(instance)
    raise AssertionError(f"No STEP occurrence for {component_id}")


@pytest.mark.parametrize("rotors", (4, 6))
def test_multirotor_exports_dynamic_graph_and_rotations(multirotor_builds, rotors: int) -> None:
    result, output, steps = multirotor_builds[rotors]
    assert_verified(result)
    assert result["parameterValues"]["rotor_count"] == rotors
    if rotors == 6:
        assert result["parameterValues"] == _HEX_PARAMETERS
    nodes = {node["id"]: node for node in result["nodes"]}
    motors = [node for node in nodes.values() if node["category"] == "motor"]
    assert len(motors) == rotors
    for node in motors:
        x, _, z = node["restPositionMeters"]
        assert np.hypot(x, z) * 2000 == pytest.approx(result["parameterValues"]["wheelbase_mm"])
    relationships = {entry["id"]: entry for entry in result["relationships"]}
    phases = [rel for rel in relationships.values() if rel.get("toPortId") == "port_phase_in"]
    assert {link["toComponentId"] for link in phases} == {node["id"] for node in motors}
    for cable in (item for item in nodes.values() if item["provenance"]["origin"] == "procedural_harness"):
        rel_id = cable["specifications"]["relationshipId"]
        assert "routingWaypointsMeters" not in relationships[rel_id]
        assert any(
            cable["id"] in step["componentIds"] and rel_id in step["relationshipIds"]
            for step in result["assemblySteps"]
        )
    for entry in result["manifest"]["files"].values():
        assert entry["publicUrl"] == f'/{entry["storagePath"]}'
    assert json.loads((output / "pipeline_result.json").read_text())["parameterValues"] == result["parameterValues"]

    arm_id = "comp_multi_arm_1"
    arm = nodes[arm_id]
    gltf = GLTF2.load_binary(str(output / "model.glb"))
    glb_arm = next(node for node in gltf.nodes if node.name == arm_id)
    half_yaw = np.deg2rad(arm["restRotationDeg"][1]) / 2
    assert glb_arm.rotation == pytest.approx([0, np.sin(half_yaw), 0, np.cos(half_yaw)], abs=1e-7)
    usda = parse_usdz_prim_paths(output / "model.usdz")
    x, y, z = map(float, arm["restRotationDeg"])
    assert f"xformOp:rotateXYZ = ({x}, {y}, {z})" in usda or re.search(
        rf'xformOp:rotateXYZ = \(0, {int(y)}, 0\)', usda
    )
    fixture = next((steps / _MULTIROTOR).glob(
        f"arm_{result['parameterValues']['wheelbase_mm'] / 2:g}_{result['parameterValues']['arm_thickness_mm']:g}.step"
    ))
    local, _, _ = read_and_validate_step(fixture)
    placed = place_shape(local, arm)
    world_step = _step_component(output / "model.step", arm_id)
    assert np.array(shape_bounds_mm(world_step)) == pytest.approx(np.array(shape_bounds_mm(placed)), abs=1e-5)


def test_parametric_parts_keep_their_pinned_digests_in_fresh_directories(tmp_path) -> None:
    catalog = CATALOG_SPECS[_MULTIROTOR]

    def parts(spec):
        return {
            node["id"]: node["expectedStepSha256"]
            for node in spec["nodes"]
            if node["origin"] == "parametric_cad" and node["stepFixtureName"]
        }

    expected = parts(catalog)
    assert parts(materialize_multirotor(catalog, tmp_path / "first")) == expected
    assert parts(materialize_multirotor(catalog, tmp_path / "second")) == expected


def test_xbf_retains_brep_bounds_faces_and_color_without_parsing_step(tmp_path, monkeypatch) -> None:
    step = REPO_COTS_LIBRARY_DIR / "kicad_quad_flight_controller.step"
    cold_ms, disk_ms = [], []
    for index in range(5):
        directory = tmp_path / str(index)
        cold = CadAssetCache(directory)
        started = perf_counter()
        original, mode = cold.load(step, "kicad_pcb_step")
        cold_ms.append(perf_counter() - started)
        assert mode == "cold_step"
        assert (directory / f"{original.sha256}.xbf").is_file()
        assert cold.load(step, "kicad_pcb_step") == (original, "warm_ram")

        disk = CadAssetCache(directory)

        def fail_ascii_parse(_path):
            pytest.fail("Disk cache hit parsed the STEP fixture")

        with monkeypatch.context() as patch:
            patch.setattr(xbf_cache, "read_xcaf_document", fail_ascii_parse)
            started = perf_counter()
            reloaded, mode = disk.load(step, "kicad_pcb_step")
            disk_ms.append(perf_counter() - started)
        assert mode == "xbf_disk"
        assert reloaded.face_count == original.face_count
        assert np.array(shape_bounds_mm(reloaded.shape)) == pytest.approx(np.array(shape_bounds_mm(original.shape)))
        assert [color for _, color in reloaded.face_colors] == [color for _, color in original.face_colors]
        assert np.array_equal(reloaded.mesh_geometry.indices, original.mesh_geometry.indices)
    assert median(disk_ms) < median(cold_ms)


def test_quadruped_offscreen_contact_sheet(tmp_path) -> None:
    result = run_cad_pipeline(
        CATALOG_SPECS["open_quadruped_v1"], tmp_path / "output", tmp_path / "steps",
        render_views_dir=tmp_path / "views",
    )
    assert_verified(result)
    assert_render(Path(result["validation"]["visualRenderPaths"][0]))


def _fault_spec() -> dict:
    catalog = CATALOG_SPECS["quadcopter_drone_v1"]
    root, motor, propeller = [
        copy.deepcopy(next(node for node in catalog["nodes"] if node["id"] == cid))
        for cid in (catalog["rootNodeId"], "comp_motor_fl", "subcomp_prop_fl")
    ]
    motor.update(parentId=root["id"], depth=1)
    propeller.update(parentId=motor["id"], depth=2)
    return {**catalog, "nodes": [root, motor, propeller], "relationships": [], "assemblySteps": []}


@pytest.mark.parametrize("fault", ("collision", "floating", "brep", "electrical"))
def test_invalid_assembly_reports_unverified(fault, tmp_path, monkeypatch) -> None:
    spec = _fault_spec()
    _, motor, propeller = spec["nodes"]
    if fault == "floating":
        propeller["restPositionMeters"][1] += 0.030
    elif fault == "brep":
        validate = xbf_cache.validate_step_shape

        def invalid_topology(shape, path):
            if path.name == propeller["stepFixtureName"]:
                shape = TopoDS_Solid()
                BRep_Builder().MakeSolid(shape)
            return validate(shape, path)

        monkeypatch.setattr(xbf_cache, "validate_step_shape", invalid_topology)
    elif fault == "electrical":
        def port(role: str, nominal: float, lower: float, upper: float) -> dict:
            return {
                "portId": "port_test", "busKind": "dc_power", "role": role, "nominalVoltageV": nominal,
                "minVoltageV": lower, "maxVoltageV": upper, "maxCurrentA": 1,
            }

        motor["ports"] = [port("sink", 5, 4, 5)]
        propeller["ports"] = [port("source", 24, 4, 26)]
        spec["relationships"] = [{
            "id": "rel_fault", "connectionType": "power_bus", "fromComponentId": motor["id"],
            "toComponentId": propeller["id"], "fromPortId": "port_test", "toPortId": "port_test",
        }]

    result = run_cad_pipeline(
        spec, tmp_path / "output", tmp_path / "steps",
        inject_collision_test=fault == "collision", xbf_cache_dir=tmp_path / "xbf",
    )
    validation = result["validation"]
    assert not validation["valid"]
    assert result["verificationStatus"] == "unverified"
    assert all(node["provenance"]["verificationStatus"] == "unverified" for node in result["nodes"])
    assert validation["failures"]
    if fault == "collision":
        assert validation["interferenceCount"] >= 1
        assert validation["repairAttempts"] == 0
    elif fault == "floating":
        assert not validation["connectivityValid"]
        assert validation["floatingComponentIds"] == [propeller["id"]]
    elif fault == "brep":
        assert not validation["brepValid"]
    elif fault == "electrical":
        assert not validation["electricalValid"]
        assert any("source nominal voltage 24 V" in failure for failure in validation["electricalFailures"])


def test_sealed_cable_port_fails_without_crossing_the_enclosure() -> None:
    sides = [
        BRepPrimAPI_MakeBox(gp_Pnt(*origin), *size).Shape()
        for origin, size in (
            ((-5, -5, -5), (1, 10, 10)), ((4, -5, -5), (1, 10, 10)),
            ((-4, -5, -5), (8, 1, 10)), ((-4, 4, -5), (8, 1, 10)),
            ((-4, -4, -5), (8, 8, 1)), ((-4, -4, 4), (8, 8, 1)),
        )
    ]
    obstacles = {f"wall_{idx}": wall for idx, wall in enumerate(sides)}
    with pytest.raises(CableRoutingBlockedError, match="Cable routing blocked: no collision-free path for rel_sealed"):
        _auto_route_bundle(
            "rel_sealed", np.zeros(3), np.array([20., 0, 0]), np.array([1., 0, 0]),
            np.array([-1., 0, 0]), "from", "to", 3, 0.9, obstacles, 0, set(),
        )


def test_voxel_search_finds_a_sparse_detour() -> None:
    wall = BRepPrimAPI_MakeBox(gp_Pnt(-3, -6, -7), 7, 12, 14).Shape()
    start, end = np.array([-7., 0, 0]), np.array([10., 0, 0])
    space = RoutingSpace(routing_boxes({"wall": wall}, set()), 1.5)
    assert not space.clear(start, end)
    result = voxel_path(space, start, end, 3.25)
    assert result is not None
    assert 3 <= len(result) <= 5
    assert all(space.clear(first, second) for first, second in zip(result, result[1:]))


@pytest.fixture
def local_runner() -> LocalOsSandboxRunner:
    return LocalOsSandboxRunner(timeout_s=8, memory_mb=1536)


def test_sandbox_executes_valid_adapter(local_runner, tmp_path) -> None:
    result = local_runner.run(_BRACKET, {"width": 14}, tmp_path)
    assert result.success, result.error
    assert result.step_path.is_relative_to(tmp_path)
    shape, digest, faces = read_and_validate_step(result.step_path)
    assert faces == result.face_count >= 4
    assert digest == result.sha256
    assert shape_bounds_mm(shape)[1][0] - shape_bounds_mm(shape)[0][0] == pytest.approx(14)


@pytest.mark.parametrize("script", [
    'open("/etc/passwd")',
    "import socket",
    "import urllib",
    "import ctypes",
    "import subprocess",
    "return params.__class__",
])
def test_sandbox_rejects_disallowed_access(local_runner, script, tmp_path) -> None:
    result = local_runner.run("def build_part(params):\n    " + script, {}, tmp_path)
    assert not result.success
    assert "not allowed" in result.error
    assert not list(tmp_path.iterdir())


def test_sandbox_blocks_step_write_outside_job(local_runner, tmp_path) -> None:
    script = """
from build123d import Box, export_step

def build_part(params):
    part = Box(2, 2, 2)
    if export_step(part, params["destination"]):
        return part
    raise ValueError("STEP write denied")
"""
    destination = tmp_path / "outside.step"
    result = local_runner.run(script, {"destination": str(destination)}, tmp_path / "jobs")
    assert not result.success
    assert not destination.exists()


def test_sandbox_times_out_busy_adapter(tmp_path) -> None:
    result = LocalOsSandboxRunner(timeout_s=4).run("def build_part(params):\n    while True: pass", {}, tmp_path)
    assert not result.success
    assert result.timed_out, result.error


def test_sandbox_kills_an_adapter_that_exceeds_rss(tmp_path) -> None:
    script = """
def build_part(params):
    allocations = []
    while True:
        allocations.append(bytearray(16 * 1024 * 1024))
"""
    result = LocalOsSandboxRunner(timeout_s=12, memory_mb=1536).run(script, {}, tmp_path)
    assert not result.success
    assert result.memory_exceeded, result.error


def test_docker_sandbox_command_is_read_only_and_resource_limited(tmp_path) -> None:
    cache, job = tmp_path / "xbf", tmp_path / "job"
    runner = DockerContainerSandboxRunner("zappd-cad-worker:test", cache, memory_mb=1024)
    command = runner.build_command(job)
    assert {"--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges"} <= set(command)
    for flag, value in (("--pids-limit", "32"), ("--memory", "1024m"), ("--cpus", "1")):
        assert command[command.index(flag) + 1] == value
    assert f"{cache}:/xbf_cache:ro" in command
    assert f"{job}:/job:rw" in command


def test_sourced_fixture_requires_expected_step_sha256_pin(tmp_path) -> None:
    rover = CATALOG_SPECS["open_source_rover_v1"]
    node = copy.deepcopy(next(item for item in rover["nodes"] if item["origin"] == "open_step_catalog" and item["stepFixtureName"]))
    node.pop("expectedStepSha256", None)
    with pytest.raises(RuntimeError, match="lacks expectedStepSha256 pin"):
        resolve_component_step(node, tmp_path)


def test_electrical_validation_flags_missing_port_declarations() -> None:
    from validation_checks import electrical_failures

    nodes = [
        {"id": "comp_a", "ports": [{"portId": "port_out", "busKind": "dc_power", "role": "source"}]},
        {"id": "comp_b"},
    ]
    relationships = [{
        "id": "rel_missing_ports",
        "connectionType": "power_bus",
        "fromComponentId": "comp_a",
        "toComponentId": "comp_b",
        "fromPortId": "port_out",
        "toPortId": "port_in",
    }]
    failures = electrical_failures(nodes, relationships)
    assert any("rel_missing_ports" in failure and "missing ports" in failure for failure in failures)


def test_parametric_generator_replaces_stale_cached_step(tmp_path) -> None:
    catalog = CATALOG_SPECS[_MULTIROTOR]
    stale = tmp_path / _MULTIROTOR / "lower_plate.step"
    stale.parent.mkdir(parents=True, exist_ok=True)
    stale.write_text("ISO-10303-21;\nSTALE\nEND-ISO-10303-21;\n", encoding="ascii")
    spec = materialize_multirotor(catalog, tmp_path)
    lower = next(node for node in spec["nodes"] if node["id"] == "comp_multi_lower")
    expected = next(node for node in catalog["nodes"] if node["id"] == "comp_multi_lower")["expectedStepSha256"]
    assert lower["expectedStepSha256"] == expected
    assert "STALE" not in stale.read_text(encoding="ascii")
