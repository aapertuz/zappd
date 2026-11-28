from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
ARTIFACT_FORMATS = ("step", "glb", "usdz")
PUBLIC_EXPORT_FILES = (
    "model.glb",
    "model.step",
    "model.usdz",
    "manifest.json",
    "pipeline_result.json",
    "interference.json",
    "engineering.json",
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as artifact:
        for chunk in iter(lambda: artifact.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_generated_poppy_export(repo_root: Path = REPO_ROOT) -> dict:
    catalog_path = repo_root / "src/shared/domain/catalog/assemblies/poppy_humanoid_v1.json"
    export_dir = repo_root / "backend/data/exports/poppy_humanoid_v1"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    result = json.loads((export_dir / "pipeline_result.json").read_text(encoding="utf-8"))
    manifest = json.loads((export_dir / "manifest.json").read_text(encoding="utf-8"))

    expected_ids = [node["id"] for node in catalog["nodes"]]
    exported_ids = [node["id"] for node in result["nodes"]]
    if (
        len(set(expected_ids)) != len(expected_ids)
        or len(set(exported_ids)) != len(exported_ids)
        or set(exported_ids) != set(expected_ids)
    ):
        raise RuntimeError("Generated Poppy export node IDs do not match the catalog")
    if result["archetypeId"] != "poppy_humanoid_v1" or result["manifest"] != manifest:
        raise RuntimeError("Generated Poppy manifest does not match the pipeline result")
    if result["verificationStatus"] != "unverified" or result["validation"]["valid"]:
        raise RuntimeError("Poppy source inspection must retain its unverified validation status")
    if not result["validation"]["failures"]:
        raise RuntimeError("Generated Poppy export lost its source validation failures")

    public_dir = repo_root / "public/assemblies" / manifest["manifestHash"]
    compatibility_dir = repo_root / "public/assemblies/poppy_humanoid_v1"
    for artifact_format in ARTIFACT_FORMATS:
        filename = f"model.{artifact_format}"
        artifact = export_dir / filename
        public_artifact = public_dir / filename
        metadata = manifest["files"][artifact_format]
        expected_hash = metadata["sha256"]
        expected_size = metadata["sizeBytes"]
        content_path = f"assemblies/{manifest['manifestHash']}/{filename}"
        if metadata["storagePath"] != content_path or metadata["publicUrl"] != f"/{content_path}":
            raise RuntimeError(f"Generated Poppy {artifact_format} URLs are not content-addressed")
        compatibility_artifact = compatibility_dir / filename
        for candidate in (artifact, public_artifact, compatibility_artifact):
            if not candidate.is_file() or candidate.stat().st_size != expected_size:
                raise RuntimeError(f"Generated Poppy {artifact_format} size does not match its manifest")
            if _sha256(candidate) != expected_hash:
                raise RuntimeError(f"Generated Poppy {artifact_format} digest does not match its manifest")

    return {
        "nodeCount": len(exported_ids),
        "manifestHash": manifest["manifestHash"],
        "artifactBytes": {
            artifact_format: manifest["files"][artifact_format]["sizeBytes"]
            for artifact_format in ARTIFACT_FORMATS
        },
    }


def refresh_compatibility_export(repo_root: Path = REPO_ROOT) -> None:
    source_dir = repo_root / "backend/data/exports/poppy_humanoid_v1"
    destination_dir = repo_root / "public/assemblies/poppy_humanoid_v1"
    destination_dir.mkdir(parents=True, exist_ok=True)
    for filename in PUBLIC_EXPORT_FILES:
        source = source_dir / filename
        if source.is_file():
            shutil.copy2(source, destination_dir / filename)


def refresh_interference_evidence(repo_root: Path = REPO_ROOT) -> None:
    catalog_path = repo_root / "src/shared/domain/catalog/assemblies/poppy_humanoid_v1.json"
    report_path = repo_root / "backend/data/exports/poppy_humanoid_v1/interference.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["catalogSha256"] = _sha256(catalog_path)
    evidence_path = repo_root / "backend/cad_worker/tests/evidence/poppy-interference.json"
    evidence_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def apply_interference_retries(retry_path: Path, repo_root: Path = REPO_ROOT) -> None:
    export_dir = repo_root / "backend/data/exports/poppy_humanoid_v1"
    catalog_path = repo_root / "src/shared/domain/catalog/assemblies/poppy_humanoid_v1.json"
    retries = json.loads(retry_path.read_text(encoding="utf-8"))
    if retries["catalogSha256"] != _sha256(catalog_path):
        raise RuntimeError("Poppy retry results do not match the current catalog")
    report = json.loads((export_dir / "interference.json").read_text(encoding="utf-8"))
    pairs = {tuple(pair["componentIds"]): pair for pair in report["pairs"]}
    for retry in retries["retries"]:
        key = tuple(retry["original"]["componentIds"])
        if pairs.get(key) != retry["original"] or retry["result"]["componentIds"] != list(key):
            raise RuntimeError("Poppy retry results do not match the original pair")
        pairs[key] = retry["result"]
    report["pairs"] = list(pairs.values())
    report["intersectionCount"] = sum(pair["status"] == "intersection" for pair in report["pairs"])
    report["unresolvedPairCount"] = sum(pair["status"] in ("failed", "timeout") for pair in report["pairs"])
    report["retryHistory"] = [*report.get("retryHistory", []), *retries["retries"]]
    result_path = export_dir / "pipeline_result.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    result["validation"]["sourceInterferenceReport"] = report
    result["validation"]["interferenceCount"] = report["intersectionCount"]
    (export_dir / "interference.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    public_dir = repo_root / "public/assemblies" / result["manifest"]["manifestHash"]
    for filename in ("interference.json", "pipeline_result.json"):
        shutil.copy2(export_dir / filename, public_dir / filename)
    refresh_compatibility_export(repo_root)
    refresh_interference_evidence(repo_root)


def main() -> int:
    commands = (
        ("build_cots_library.py",),
        ("ingest_upstream_catalog.py", "--poppy"),
        ("cli.py", "--archetype", "poppy_humanoid_v1", "--public-dir", "public/assemblies"),
    )
    for command in commands:
        subprocess.run(
            [sys.executable, str(REPO_ROOT / "backend/cad_worker" / command[0]), *command[1:]],
            cwd=REPO_ROOT,
            check=True,
        )
    refresh_compatibility_export()
    summary = verify_generated_poppy_export()
    refresh_interference_evidence()
    with tempfile.TemporaryDirectory(prefix="zappd-poppy-retries-") as temporary_dir:
        retry_path = Path(temporary_dir) / "retries.json"
        subprocess.run(
            [sys.executable, str(REPO_ROOT / "backend/cad_worker/retry_poppy_pairs.py"), str(retry_path)],
            cwd=REPO_ROOT,
            check=True,
        )
        if retry_path.is_file():
            apply_interference_retries(retry_path)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
