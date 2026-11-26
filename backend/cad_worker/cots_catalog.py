from __future__ import annotations

import json
from pathlib import Path
from typing import Any


COTS_REGISTRY = Path(__file__).resolve().parents[2] / "src/shared/domain/catalog/cots/index.json"


def load_cots_catalog() -> list[dict[str, Any]]:
    return json.loads(COTS_REGISTRY.read_text(encoding="utf-8"))


def get_cots_part(cots_id: str) -> dict[str, Any] | None:
    return next((part for part in load_cots_catalog() if part["cotsId"] == cots_id), None)


def search_cots_parts(
    *,
    bus_kind: str | None = None,
    mounting_kind: str | None = None,
    origin: str | None = None,
    max_dimension_mm: float | None = None,
    text: str = "",
) -> list[dict[str, Any]]:
    query = text.strip().casefold()
    return [
        part
        for part in load_cots_catalog()
        if (origin is None or part["origin"] == origin)
        and (max_dimension_mm is None or max(part["dimensionsMm"]) <= max_dimension_mm)
        and (
            bus_kind is None
            or any(bus_kind == port["busKind"] or bus_kind in port.get("compatibleBusKinds", ())
                   for port in part["ports"])
        )
        and (
            mounting_kind is None
            or any(mounting_kind == mount["kind"] for mount in part.get("mountingInterfaces", ()))
        )
        and (
            not query
            or any(query in field.casefold() for field in (
                part["cotsId"], part["name"], part.get("category", ""), *part.get("tags", ())
            ))
        )
    ]
