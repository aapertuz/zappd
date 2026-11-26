from __future__ import annotations

import json
import re
import sys
from types import ModuleType
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cli


CATALOG_PATH = (
    Path(__file__).resolve().parents[3]
    / "src"
    / "shared"
    / "domain"
    / "data"
    / "dual_scorpion_v1.json"
)


def test_dual_scorpion_catalog_preserves_pinned_part_identity_and_frames() -> None:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    nodes = catalog["nodes"]
    components = [node for node in nodes if node["category"] == "cad_part"]
    ids = {node["id"] for node in nodes}

    assert catalog["archetypeId"] == "dual_scorpion_v1"
    assert catalog["sourceCommit"] == "cc5b46ca9611ea5568b017bc5bff9f01945d25a3"
    assert catalog["sourceArchiveSha256"] == "236fc7e45a0bc09d1368047243eb19913b6970dc3bc21e997b47d5ca76a7647b"
    assert catalog["sourceLicense"] == "Apache-2.0"
    assert len(components) == 70
    assert sum(node["geometry"]["kind"] == "available" for node in components) == 57
    assert sum(node["geometry"]["kind"] == "unavailable" for node in components) == 13
    assert len(ids) == len(nodes)
    assert sum(node["parentId"] is None for node in nodes) == 1
    assert all(node["parentId"] is None or node["parentId"] in ids for node in nodes)
    assert all(re.fullmatch(r"[a-f0-9]{64}", node["specifications"]["sourceSha256"]) for node in components)
    assert all("raw.githubusercontent.com" in node["sourceUrl"] for node in components)
    assert all(node["sourceUrl"].startswith("https://raw.githubusercontent.com/momoiorg-repository/dual_scorpion/" + catalog["sourceCommit"] + "/STEP/follower/") for node in components)
    assert all(node["parentId"] == f"dual_scorpion_{node['specifications']['urdfLinkName']}" for node in components)
    assert all(node["explodeDistanceMeters"] > 0 for node in nodes if node["parentId"] is not None)
    assert catalog["relationships"] == []
    assert catalog["assemblySteps"] == []
    assert catalog["sourceAlignment"]["matchedStepParts"] == 70
    assert catalog["sourceAlignment"]["maximumCollisionBoundsErrorMm"] < 1.0
    assert catalog["sourceAlignment"]["maximumAcceptedErrorMm"] == 1.0

    base = next(node for node in components if node["id"] == "dual_scorpion_part_base")
    assert base["restPositionMeters"] == [-0.000646, 0.010686, 0.001696]
    assert base["specifications"]["sourceCoordinateFrame"] == "step_z_up_global_millimeters"


def test_cli_persists_pipeline_wrapper_metadata_for_cached_inspection(
    tmp_path: Path, monkeypatch
) -> None:
    catalog_module = ModuleType("dual_scorpion_catalog")
    catalog_module.CATALOG_PATH = tmp_path / "catalog.json"
    catalog_module.download_pinned_archive = lambda path: path
    catalog_module.prepare_pinned_source = lambda archive, cache, catalog: {"nodes": []}
    pipeline_module = ModuleType("dual_scorpion_pipeline")
    pipeline_module.run_dual_scorpion_pipeline = lambda spec, output_dir, cache_dir, inject_collision_test: {
        "archetypeId": "dual_scorpion_v1",
        "verificationStatus": "unverified",
        "validation": {"sourceInspection": True},
    }
    monkeypatch.setitem(sys.modules, "dual_scorpion_catalog", catalog_module)
    monkeypatch.setitem(sys.modules, "dual_scorpion_pipeline", pipeline_module)
    output_dir = tmp_path / "exports"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "cli.py",
            "--archetype",
            "dual_scorpion_v1",
            "--source-archive",
            "pinned.zip",
            "--output-dir",
            str(output_dir),
        ],
    )

    assert cli.main() == 0

    result = json.loads((output_dir / "pipeline_result.json").read_text(encoding="utf-8"))
    assert result["validation"]["sourceInspection"] is True
