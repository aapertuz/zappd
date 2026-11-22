from __future__ import annotations

import hashlib
import shutil
from pathlib import Path
from typing import Any

from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer


REPO_STEP_CACHE_DIR = Path(__file__).resolve().parents[1] / "data" / "open_step_cache"
MIN_CAD_BREP_FACES = 4


def count_brep_faces(shape: Any) -> int:
    count = 0
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        count += 1
        explorer.Next()
    return count


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


def resolve_component_step(node_spec: dict[str, Any], cache_dir: Path) -> dict[str, Any]:
    fixture_name = node_spec.get("stepFixtureName")
    if fixture_name is None:
        return {"hasGeometry": False}

    origin = node_spec.get("origin")
    source_url = str(node_spec.get("sourceUrl", ""))
    spdx_license = str(node_spec.get("spdxLicense", ""))

    if origin != "open_step_catalog":
        raise RuntimeError(
            f"Component {node_spec['id']} uses disallowed origin '{origin}'; Phase 1 requires open_step_catalog"
        )
    if not source_url.startswith("https://") or not spdx_license.strip():
        raise RuntimeError(
            f"Component {node_spec['id']} is missing verified HTTPS sourceUrl or SPDX license"
        )

    cache_dir.mkdir(parents=True, exist_ok=True)
    step_path = cache_dir / str(fixture_name)
    if not step_path.exists():
        repo_step_path = REPO_STEP_CACHE_DIR / str(fixture_name)
        if repo_step_path.exists() and repo_step_path.resolve() != step_path.resolve():
            shutil.copy2(repo_step_path, step_path)

    expected_sha = node_spec.get("expectedStepSha256")
    shape, sha256_hex, face_count = read_and_validate_step(
        step_path,
        expected_sha256=str(expected_sha) if expected_sha else None,
    )

    return {
        "hasGeometry": True,
        "shape": shape,
        "stepPath": step_path,
        "sha256": sha256_hex,
        "faceCount": face_count,
        "initialStatus": "unverified",
        "targetVerifiedStatus": "sourced_verified",
    }
