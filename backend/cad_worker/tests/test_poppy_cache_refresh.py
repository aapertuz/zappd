from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from refresh_poppy_cache import apply_interference_retries, refresh_interference_evidence, verify_generated_poppy_export


def _write_export(root: Path, catalog_ids: list[str], exported_ids: list[str]) -> None:
    catalog_dir = root / "src/shared/domain/catalog/assemblies"
    export_dir = root / "backend/data/exports/poppy_humanoid_v1"
    catalog_dir.mkdir(parents=True)
    export_dir.mkdir(parents=True)
    (catalog_dir / "poppy_humanoid_v1.json").write_text(
        json.dumps({"nodes": [{"id": node_id} for node_id in catalog_ids]}),
        encoding="utf-8",
    )
    files = {}
    for artifact_format in ("step", "glb", "usdz"):
        filename = f"model.{artifact_format}"
        payload = f"{artifact_format}-artifact".encode()
        (export_dir / filename).write_bytes(payload)
        files[artifact_format] = {
            "sha256": hashlib.sha256(payload).hexdigest(),
            "sizeBytes": len(payload),
            "storagePath": f"assemblies/{'a' * 64}/{filename}",
            "publicUrl": f"/assemblies/{'a' * 64}/{filename}",
        }
    manifest = {"manifestHash": "a" * 64, "files": files}
    result = {
        "archetypeId": "poppy_humanoid_v1",
        "verificationStatus": "unverified",
        "validation": {"valid": False, "failures": ["Source inspection remains unverified"]},
        "nodes": [{"id": node_id} for node_id in exported_ids],
        "manifest": manifest,
    }
    (export_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (export_dir / "pipeline_result.json").write_text(json.dumps(result), encoding="utf-8")
    public_dir = root / "public/assemblies" / manifest["manifestHash"]
    public_dir.mkdir(parents=True)
    compatibility_dir = root / "public/assemblies/poppy_humanoid_v1"
    compatibility_dir.mkdir(parents=True)
    for artifact_format in ("step", "glb", "usdz"):
        shutil.copy2(export_dir / f"model.{artifact_format}", public_dir)
        shutil.copy2(export_dir / f"model.{artifact_format}", compatibility_dir)


def test_refresh_export_verifier_accepts_complete_unverified_poppy_output(tmp_path: Path) -> None:
    _write_export(tmp_path, ["root", "part"], ["root", "part"])

    summary = verify_generated_poppy_export(tmp_path)

    assert summary["nodeCount"] == 2
    assert summary["manifestHash"] == "a" * 64
    assert summary["artifactBytes"] == {"step": 13, "glb": 12, "usdz": 13}


def test_refresh_export_verifier_rejects_stale_node_coverage(tmp_path: Path) -> None:
    _write_export(tmp_path, ["root", "part", "new_part"], ["root", "part"])

    with pytest.raises(RuntimeError, match="node IDs do not match the catalog"):
        verify_generated_poppy_export(tmp_path)


def test_refresh_export_verifier_rejects_changed_published_artifact(tmp_path: Path) -> None:
    _write_export(tmp_path, ["root"], ["root"])
    (tmp_path / "public/assemblies" / ("a" * 64) / "model.glb").write_bytes(b"changed-data")

    with pytest.raises(RuntimeError, match="glb digest does not match its manifest"):
        verify_generated_poppy_export(tmp_path)


def test_refresh_interference_evidence_preserves_measured_failures(tmp_path: Path) -> None:
    _write_export(tmp_path, ["root"], ["root"])
    report = {"intersectionCount": 102, "unresolvedPairCount": 2, "status": "partial"}
    report_path = tmp_path / "backend/data/exports/poppy_humanoid_v1/interference.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    evidence_path = tmp_path / "backend/cad_worker/tests/evidence/poppy-interference.json"
    evidence_path.parent.mkdir(parents=True)

    refresh_interference_evidence(tmp_path)

    refreshed = json.loads(evidence_path.read_text(encoding="utf-8"))
    catalog_path = tmp_path / "src/shared/domain/catalog/assemblies/poppy_humanoid_v1.json"
    assert refreshed.pop("catalogSha256") == hashlib.sha256(catalog_path.read_bytes()).hexdigest()
    assert refreshed == report


def test_retry_results_require_matching_catalog_and_pair_and_preserve_unverified_status(tmp_path: Path) -> None:
    _write_export(tmp_path, ["root"], ["root"])
    original = {"componentIds": ["first", "second"], "status": "timeout", "volumeMm3": None}
    resolved = {**original, "status": "contact_or_below_threshold", "volumeMm3": 0.0}
    export_dir = tmp_path / "backend/data/exports/poppy_humanoid_v1"
    (export_dir / "interference.json").write_text(json.dumps({"pairs": [original]}))
    catalog = tmp_path / "src/shared/domain/catalog/assemblies/poppy_humanoid_v1.json"
    retries = {
        "catalogSha256": "stale",
        "retries": [{"original": original, "result": resolved, "timeoutSeconds": 180}],
    }
    retry_path = tmp_path / "retries.json"
    retry_path.write_text(json.dumps(retries))
    with pytest.raises(RuntimeError, match="current catalog"):
        apply_interference_retries(retry_path, tmp_path)
    retries["catalogSha256"] = hashlib.sha256(catalog.read_bytes()).hexdigest()
    retries["retries"][0]["original"] = {**original, "status": "failed"}
    retry_path.write_text(json.dumps(retries))
    with pytest.raises(RuntimeError, match="original pair"):
        apply_interference_retries(retry_path, tmp_path)
    retries["retries"][0]["original"] = original
    retry_path.write_text(json.dumps(retries))
    (tmp_path / "backend/cad_worker/tests/evidence").mkdir(parents=True)

    apply_interference_retries(retry_path, tmp_path)

    result = json.loads((export_dir / "pipeline_result.json").read_text())
    assert result["verificationStatus"] == "unverified"
    assert result["validation"]["valid"] is False
    report = result["validation"]["sourceInterferenceReport"]
    assert report["pairs"] == [resolved]
    assert report["unresolvedPairCount"] == 0
    assert report["retryHistory"] == retries["retries"]
    for directory in ("a" * 64, "poppy_humanoid_v1"):
        published = tmp_path / "public/assemblies" / directory / "pipeline_result.json"
        assert json.loads(published.read_text()) == result
