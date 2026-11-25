from __future__ import annotations

import json
from pathlib import Path
from typing import Any


CATALOG_DIR = Path(__file__).resolve().parents[2] / "src" / "shared" / "domain" / "catalog" / "assemblies"
CATALOG_ORDER = {
    "quadcopter_drone_v1": 0,
    "robotic_arm_3dof_v1": 1,
    "open_source_rover_v1": 2,
    "open_quadruped_v1": 3,
}


def _load_catalog_specs() -> dict[str, dict[str, Any]]:
    paths = sorted(
        CATALOG_DIR.glob("*.json"),
        key=lambda path: (CATALOG_ORDER.get(path.stem, len(CATALOG_ORDER)), path.stem),
    )
    specs = {}
    for path in paths:
        spec = json.loads(path.read_text(encoding="utf-8"))
        archetype_id = spec["archetypeId"]
        if archetype_id != path.stem:
            raise ValueError(f"Catalog archetypeId {archetype_id!r} does not match {path.name}")
        specs[archetype_id] = spec
    return specs


CATALOG_SPECS: dict[str, dict[str, Any]] = _load_catalog_specs()


def resolve_catalog_spec(archetype_id: str, catalog_json_path: str | None = None) -> dict[str, Any]:
    if catalog_json_path is not None:
        return json.loads(Path(catalog_json_path).read_text(encoding="utf-8"))
    if archetype_id not in CATALOG_SPECS:
        raise ValueError(f"Unknown archetypeId: {archetype_id}")
    return CATALOG_SPECS[archetype_id]
