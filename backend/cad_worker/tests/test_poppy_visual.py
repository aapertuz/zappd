import hashlib
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from poppy_visual import ARCHIVE_SHA256, HEAD_ID, MEMBER_SHA256, load_head_visual, verify_digest, visual_state


def test_visual_source_rejects_changed_bytes():
    verify_digest(b"source", hashlib.sha256(b"source").hexdigest())
    with pytest.raises(ValueError, match="SHA-256"):
        verify_digest(b"changed", hashlib.sha256(b"source").hexdigest())


def test_visual_state_retains_rejected_cad_and_separate_source():
    state = visual_state("Invalid BRep topology")
    assert state["kind"] == "visual_only"
    assert state["cadRejectionReason"] == "Invalid BRep topology"
    assert state["sha256"] == MEMBER_SHA256
    assert state["archiveSha256"] == ARCHIVE_SHA256
    assert state["sourceOccurrencePath"] == HEAD_ID.removeprefix("poppy_")
    assert state["sourceCoordinateFrame"] == "assembly_y_up_millimeters"


def test_official_mesh_retains_source_placement_and_shell_dimensions(tmp_path):
    archive = Path(__file__).resolve().parents[2] / "data/open_step_cache/poppy-1.0.2-print-stl.zip"
    if not archive.exists():
        pytest.skip("Pinned upstream mesh cache not downloaded")
    (tmp_path / archive.name).write_bytes(archive.read_bytes())
    rest = [0.0, 0.33642830040470106, 0.022285019608571526]
    geometry = load_head_visual(tmp_path, rest)
    world_mm = (geometry["vertices"] + np.array(rest)) * 1000
    np.testing.assert_allclose(world_mm.min(0), [-66.566589, 284.281036, -23.328997], atol=0.0001)
    np.testing.assert_allclose(world_mm.max(0), [66.566589, 388.574493, 67.899033], atol=0.0001)
    assert len(geometry["indices"]) == 264978 * 3
    assert len(geometry["normals"]) == len(geometry["vertices"])
    (tmp_path / archive.name).write_bytes(b"changed")
    with pytest.raises(ValueError, match="SHA-256"):
        load_head_visual(tmp_path, rest)


def test_visual_shell_exports_both_formats_without_entering_engineering_cad(tmp_path):
    import copy
    from catalog_specs import CATALOG_SPECS
    from poppy_pipeline import run_poppy_pipeline
    from geometry_pipeline import parse_usdz_prim_paths

    archive = Path(__file__).resolve().parents[2] / "data/open_step_cache/poppy-1.0.2-print-stl.zip"
    if not archive.exists():
        pytest.skip("Pinned upstream mesh cache not downloaded")
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / archive.name).write_bytes(archive.read_bytes())
    source = CATALOG_SPECS["quadcopter_drone_v1"]["nodes"]
    nodes = copy.deepcopy([node for node in source if node["id"] in ("proj_quadcopter", "sub_chassis", "comp_base_plate_lower")])
    for node in nodes:
        node["geometry"] = {"kind": "available", "role": "solid"} if node["stepFixtureName"] else {"kind": "assembly"}
        node["specifications"]["sourceSha256"] = "a" * 64
    head = copy.deepcopy(nodes[-1])
    head.update(id=HEAD_ID, name="head_face", stepFixtureName=None, geometry={"kind": "unavailable", "reason": "Invalid source topology"})
    nodes.append(head)
    result = run_poppy_pipeline({"archetypeId": "poppy_humanoid_v1", "nodes": nodes}, tmp_path / "exports", cache)
    assert result["validation"]["availableGeometryCount"] == 1
    assert result["validation"]["visualOnlyComponentIds"] == [HEAD_ID]
    assert result["validation"]["rejectedCadComponentIds"] == [HEAD_ID]
    assert result["validation"]["valid"] is False
    assert result["validation"]["nodeMappingComplete"] is True
    rendered_head = next(node for node in result["nodes"] if node["id"] == HEAD_ID)
    assert rendered_head["geometry"] == visual_state("Invalid source topology")
    assert rendered_head["provenance"]["verificationStatus"] == "unverified"
    assert rendered_head["provenance"]["stepSha256"] == "a" * 64
    assert HEAD_ID in result["glbNodeIds"]
    assert HEAD_ID in parse_usdz_prim_paths(tmp_path / "exports/model.usdz")
    assert head["geometry"]["kind"] == "unavailable"
