import hashlib
import json
import re
import shutil
import sys
from collections import Counter
from copy import deepcopy
from pathlib import Path

import numpy as np
import pytest
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeVertex
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.gp import gp_Pnt
from pygltflib import GLTF2

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from catalog_ingestor import REPO_STEP_CACHE_DIR, read_xcaf_face_colors, resolve_component_step
from geometry_pipeline import parse_usdz_prim_paths, world_rest_to_cad_mm
from poppy_catalog import POPPY_SPEC_PATH
from poppy_electronics import ELECTRONICS_ID, WIRING_ID, apply_poppy_electronics
from poppy_interference import load_cached_report
from poppy_pipeline import run_poppy_pipeline
from poppy_visual import HEAD_ID


@pytest.fixture(scope="module")
def spec():
    return json.loads(POPPY_SPEC_PATH.read_text())


@pytest.fixture(scope="module")
def by_id(spec):
    return {node["id"]: node for node in spec["nodes"]}


def test_source_occurrences_and_cable_topology(spec, by_id):
    assert len(by_id) == len(spec["nodes"]) == 289
    assert spec["semantics"] == "source_inspection"
    assert spec["assemblySteps"] == []
    assert by_id[HEAD_ID]["geometry"]["kind"] == "unavailable"
    assert by_id[HEAD_ID]["stepFixtureName"] is None
    for subsystem in (ELECTRONICS_ID, WIRING_ID):
        assert by_id[subsystem]["parentId"] == spec["rootNodeId"]
        assert by_id[subsystem]["geometry"] == {"kind": "assembly"}
    boards = [node for node in by_id.values() if node["parentId"] == ELECTRONICS_ID]
    cables = [node for node in by_id.values() if node["parentId"] == WIRING_ID]
    assert [node["id"] for node in boards] == [
        "comp_poppy_usb2ax_upper", "comp_poppy_usb2ax_lower", "comp_poppy_upper_3p_hub",
    ]
    assert len(cables) == 33
    assert all(node["explodeDistanceMeters"] > 0 for node in [*boards, *cables])
    assert all(node["geometry"] == {"kind": "available", "role": "solid"} for node in [*boards, *cables])
    relationships = {rel["id"]: rel for rel in spec["relationships"]}
    assert len(relationships) == len(spec["relationships"]) == 69
    mounts = {rel["toComponentId"] for rel in relationships.values() if rel["connectionType"] == "assembly_mount"}
    assert mounts == {node["id"] for node in [*boards, *cables]}
    assert Counter(node["specifications"]["controller"] for node in cables) == {
        "upper_body_controller": 18, "lower_body_controller": 13, "head_peripherals": 2,
    }
    motors = [node for node in by_id.values() if "motorId" in node["specifications"]]
    assert len(motors) == len({node["specifications"]["motorId"] for node in motors}) == 25
    assert all({port["portId"] for port in node["ports"]} == {"port_dxl_in", "port_dxl_out"} for node in motors)
    active_ports = set()
    for cable in cables:
        relationship = relationships[cable["specifications"]["relationshipId"]]
        assert cable["sourceUrl"] == f"harness://zappd/poppy_humanoid_v1/{relationship['id']}"
        bus = cable["specifications"]["busKind"]
        assert relationship["connectionType"] == ("power_bus" if bus == "dc_power" else "electrical_bus")
        assert relationship["routingStyle"] == "filleted_polyline"
        for end in ("from", "to"):
            endpoint = by_id[relationship[f"{end}ComponentId"]]
            port = next(p for p in endpoint["ports"] if p["portId"] == relationship[f"{end}PortId"])
            port_key = endpoint["id"], port["portId"]
            assert port_key not in active_ports
            active_ports.add(port_key)
            assert port["busKind"] == bus
            controller = endpoint["specifications"].get("controller")
            if controller is not None:
                assert controller == cable["specifications"]["controller"]
            if bus == "dc_power":
                assert port["nominalVoltageV"] == 12


def test_source_port_anchors_are_on_or_near_their_pinned_cad(by_id, tmp_path):
    populated = [node for node in by_id.values() if node.get("ports") and node["origin"] == "open_step_catalog"]
    assert len(populated) == 31
    for node in populated:
        shape = resolve_component_step(node, tmp_path)["shape"]
        for port in node["ports"]:
            point = np.array(world_rest_to_cad_mm(port["localPositionMeters"]))
            direction = np.array(world_rest_to_cad_mm(port["exitDirection"])) / 1000
            assert np.linalg.norm(direction) == pytest.approx(1.0)
            anchor = BRepBuilderAPI_MakeVertex(gp_Pnt(*point)).Vertex()
            lead = BRepBuilderAPI_MakeEdge(gp_Pnt(*point), gp_Pnt(*(point + direction * 2))).Edge()
            at_port = BRepExtrema_DistShapeShape(anchor, shape)
            past_port = BRepExtrema_DistShapeShape(lead, shape)
            assert at_port.IsDone() and past_port.IsDone(), (node["id"], port["portId"])
            assert at_port.Value() <= 1.1, (node["id"], port["portId"])
            assert past_port.Value() > 0.05, (node["id"], port["portId"])


def test_composition_preserves_source_and_regenerates_the_same_cables(spec, tmp_path):
    deannotated_nodes = deepcopy([node for node in spec["nodes"] if node["id"].startswith("poppy_")])
    for node in deannotated_nodes:
        node.pop("ports", None)
        for key in set(node["specifications"]) - {
            "sourceSha256", "sourceOccurrencePath", "engineeringValidation", "brepFaces", "geometryStatus", "geometryDetail",
        }:
            del node["specifications"][key]
    assert sum(node["stepFixtureName"] is not None for node in deannotated_nodes) == 201
    base = {**spec, "nodes": deannotated_nodes, "relationships": []}
    assert apply_poppy_electronics(base, tmp_path / "first") == apply_poppy_electronics(spec, tmp_path / "second") == spec
    for node in spec["nodes"]:
        if node["origin"] != "procedural_harness":
            continue
        for run in ("first", "second"):
            step = tmp_path / run / node["stepFixtureName"]
            assert hashlib.sha256(step.read_bytes()).hexdigest() == node["expectedStepSha256"]
        colors = {color for _, color in read_xcaf_face_colors(step) if color is not None}
        assert len(colors) >= 2


def test_pipeline_exports_added_boards_and_cables_with_unverified_provenance(spec, by_id, tmp_path):
    cache = tmp_path / "cache"
    archive = REPO_STEP_CACHE_DIR / "poppy-1.0.2-print-stl.zip"
    if archive.is_file():
        cache.mkdir()
        shutil.copy2(archive, cache)
    output = tmp_path / "exports"
    result = run_poppy_pipeline(spec, output, cache)
    validation = result["validation"]
    assert result["verificationStatus"] == "unverified"
    assert result["engineeringReport"]["manufacturingReadiness"] == "not_established"
    assert validation["brepValid"] and validation["nodeMappingComplete"]
    assert validation["maxDimensionalErrorMm"] <= 0.1
    assert validation["rejectedCadComponentIds"] == [HEAD_ID]
    assert not any("declared solid contains open surface" in failure for failure in validation["failures"])
    assert next(node for node in result["nodes"] if node["id"] == HEAD_ID)["geometry"]["kind"] == "visual_only"

    added_ids = {cid for cid in by_id if cid.startswith("comp_poppy_")}
    glb = GLTF2().load(str(output / "model.glb"))
    usda = parse_usdz_prim_paths(output / "model.usdz")
    products = Counter(re.findall(r"PRODUCT\('([a-z0-9_]+)'", (output / "model.step").read_text()))
    assert products[HEAD_ID] == 0
    for cid in added_ids:
        glb_node, = (node for node in glb.nodes if node.name == cid)
        primitives = glb.meshes[glb_node.mesh].primitives
        assert len(primitives) >= 2
        assert all(glb.materials[primitive.material].normalTexture is not None for primitive in primitives)
        assert usda.count(f'def Xform "{cid}"') == 1
        assert products[cid] == 1
        if by_id[cid]["origin"] == "procedural_harness":
            assert sum(products[f"{cid}_wire_{index}"] for index in range(1, 5)) == len(primitives)
    report = load_cached_report(spec, cache)
    assert report == validation["sourceInterferenceReport"]
    assert report["solidCount"] == 235
    assert report["intersectionCount"] == 102
    assert report["unresolvedPairCount"] == 0
    assert all(
        pair["status"] == "contact_or_below_threshold"
        for pair in report["pairs"] if added_ids.intersection(pair["componentIds"])
    )
