import hashlib
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

import numpy as np

from ingest_upstream_catalog import fetch_bytes

HEAD_ID = "poppy_1_28_5"
ARCHIVE_URL = "https://github.com/poppy-project/poppy-humanoid/releases/download/1.0.2/STL_3D_printed_parts.zip"
ARCHIVE_SHA256 = "c67a4e53e10b6be5c7dc29737ec7e8bfb8f299ac62c05a0659d2b9481bd5583e"
MEMBER = "STL_3D_printed_parts/head/head_face.STL"
MEMBER_SHA256 = "af7366acad9f1ea6e5e509b9d8c4063dca5d91b8f2b60a3c9b5092082ddd37f0"


def verify_digest(payload: bytes, expected: str) -> None:
    if hashlib.sha256(payload).hexdigest() != expected:
        raise ValueError("Poppy visual source SHA-256 mismatch")


def load_head_visual(cache_dir: Path, rest_position: list[float]) -> dict:
    archive_path = cache_dir / "poppy-1.0.2-print-stl.zip"
    archive = archive_path.read_bytes() if archive_path.exists() else fetch_bytes(ARCHIVE_URL)
    verify_digest(archive, ARCHIVE_SHA256)
    with ZipFile(BytesIO(archive)) as source:
        payload = source.read(MEMBER)
    verify_digest(payload, MEMBER_SHA256)
    cache_dir.mkdir(parents=True, exist_ok=True)
    archive_path.write_bytes(archive)
    record = np.dtype([("normal", "<f4", (3,)), ("vertices", "<f4", (3, 3)), ("attribute", "<u2")])
    count = int.from_bytes(payload[80:84], "little")
    if len(payload) != 84 + count * record.itemsize:
        raise ValueError("Invalid source STL length")
    triangles = np.frombuffer(payload, dtype=record, offset=84)
    vertices = triangles["vertices"].reshape(-1, 3) / 1000.0 - np.array(rest_position)
    normals = np.repeat(triangles["normal"], 3, axis=0)
    if not np.isfinite(vertices).all() or not np.isfinite(normals).all():
        raise ValueError("Nonfinite source STL geometry")
    return {"vertices": vertices.astype(np.float32), "normals": normals.astype(np.float32), "indices": np.arange(count * 3, dtype=np.uint32)}


def visual_state(cad_reason: str) -> dict:
    return {"kind": "visual_only", "cadRejectionReason": cad_reason,
            "sourceUrl": ARCHIVE_URL, "archiveSha256": ARCHIVE_SHA256,
            "memberPath": MEMBER, "sha256": MEMBER_SHA256,
            "spdxLicense": "CC-BY-SA-4.0", "sourceOccurrencePath": "1_28_5",
            "sourceCoordinateFrame": "assembly_y_up_millimeters"}
