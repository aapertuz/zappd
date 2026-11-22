from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from catalog_specs import CATALOG_SPECS
from geometry_pipeline import parse_glb_diagnostics, parse_usdz_prim_paths, run_cad_pipeline


EXPECTED_NODE_COUNTS = {
    "quadcopter_drone_v1": 30,
    "robotic_arm_3dof_v1": 24,
    "open_source_rover_v1": 15,
}


def test_all_robotics_categories_pass_opencascade_validation(tmp_path: Path) -> None:
    cache_dir = tmp_path / "step_cache"
    assert set(CATALOG_SPECS.keys()) == set(EXPECTED_NODE_COUNTS.keys())

    for archetype_id, spec in CATALOG_SPECS.items():
        out_dir = tmp_path / "exports" / archetype_id
        result = run_cad_pipeline(spec, output_dir=out_dir, cache_dir=cache_dir)

        assert len(result["nodes"]) == EXPECTED_NODE_COUNTS[archetype_id]
        validation = result["validation"]
        assert validation["valid"] is True, f"{archetype_id} failed: {validation['failures']}"
        assert validation["brepValid"] is True
        assert validation["interferenceCount"] == 0
        assert validation["maxDimensionalErrorMm"] <= 0.1
        assert validation["nodeMappingComplete"] is True
        assert validation["unitSystem"] == "meters_y_up"

        expected_leaf_ids = {
            n["id"] for n in spec["nodes"] if n["level"] in ("component", "subcomponent")
        }
        glb_ids, _ = parse_glb_diagnostics(out_dir / "model.glb")
        usda = parse_usdz_prim_paths(out_dir / "model.usdz")
        assert set(glb_ids) == expected_leaf_ids
        for cid in expected_leaf_ids:
            assert f'custom string componentId = "{cid}"' in usda

        for node in result["nodes"]:
            prov = node["provenance"]
            assert prov["origin"] == "open_step_catalog"
            assert prov["verificationStatus"] == "sourced_verified"
            assert prov["spdxLicense"]
            assert prov["sourceUrl"].startswith("https://")
            assert len(prov["stepSha256"]) == 64
            if node["level"] in ("component", "subcomponent"):
                assert node["specifications"]["brepFaces"] >= 4

        assert (out_dir / "model.step").stat().st_size > 0
        assert (out_dir / "model.glb").stat().st_size > 0
        assert (out_dir / "model.usdz").stat().st_size > 0


def test_collision_injection_rejects_and_marks_unverified(tmp_path: Path) -> None:
    cache_dir = tmp_path / "step_cache"
    out_dir = tmp_path / "collision_export"
    result = run_cad_pipeline(
        CATALOG_SPECS["quadcopter_drone_v1"],
        output_dir=out_dir,
        cache_dir=cache_dir,
        inject_collision_test=True,
    )
    assert result["validation"]["valid"] is False
    assert result["validation"]["interferenceCount"] >= 1
    assert result["verificationStatus"] == "unverified"
    for node in result["nodes"]:
        assert node["provenance"]["verificationStatus"] == "unverified"


def test_disallowed_fallback_origin_is_rejected(tmp_path: Path) -> None:
    cache_dir = tmp_path / "step_cache"
    out_dir = tmp_path / "invalid_origin_export"
    tampered = copy.deepcopy(CATALOG_SPECS["open_source_rover_v1"])
    for node in tampered["nodes"]:
        if node.get("stepFixtureName"):
            node["origin"] = "build123d_fallback"
            break
    with pytest.raises(RuntimeError, match="disallowed origin"):
        run_cad_pipeline(tampered, output_dir=out_dir, cache_dir=cache_dir)
