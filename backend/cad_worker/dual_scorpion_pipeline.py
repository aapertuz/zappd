from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from geometry_pipeline import run_cad_pipeline
from poppy_interference import analyze


def run_dual_scorpion_pipeline(
    spec: dict[str, Any],
    output_dir: Path,
    cache_dir: Path,
    inject_collision_test: bool = False,
    *,
    asset_cache=None,
    xbf_cache_dir: Path | None = None,
    parameter_overrides: dict[str, float | int] | None = None,
    render_views_dir: Path | None = None,
) -> dict[str, Any]:
    del parameter_overrides
    output_dir.mkdir(parents=True, exist_ok=True)
    result = run_cad_pipeline(
        spec,
        output_dir,
        cache_dir,
        inject_collision_test=inject_collision_test,
        check_interference=False,
        allow_partial_geometry=True,
        asset_cache=asset_cache,
        xbf_cache_dir=xbf_cache_dir,
        render_views_dir=render_views_dir,
    )
    result_nodes = {node["id"]: node for node in result["nodes"]}
    for source_node in spec["nodes"]:
        node = result_nodes[source_node["id"]]
        node["geometry"] = source_node["geometry"]
        node["provenance"]["verificationStatus"] = "unverified"
        if source_node["geometry"]["kind"] == "unavailable":
            node["provenance"]["stepSha256"] = source_node["specifications"]["sourceSha256"]

    interference = analyze(spec, cache_dir)
    validation = result["validation"]
    validation["interferenceCheck"] = "partial"
    validation["interferenceCount"] = interference["intersectionCount"]
    validation["sourceInterferenceReport"] = interference
    validation["failures"] = [
        failure
        for failure in validation["failures"]
        if failure != "Volumetric interference analysis not performed for source inspection"
    ]
    if interference["intersectionCount"] or interference["unresolvedPairCount"]:
        validation["failures"].append(
            "Source interference report contains overlaps or unresolved pairs"
        )
    (output_dir / "interference.json").write_text(json.dumps(interference, indent=2))

    unavailable_ids = sorted(
        node["id"] for node in spec["nodes"] if node["geometry"]["kind"] == "unavailable"
    )
    surface_ids = sorted(
        node["id"]
        for node in spec["nodes"]
        if node["geometry"].get("kind") == "available"
        and node["geometry"].get("role") == "surface"
    )
    validation["availableGeometryCount"] = sum(
        node["geometry"]["kind"] == "available" for node in spec["nodes"]
    )
    validation["unavailableComponentIds"] = unavailable_ids
    validation["surfaceComponentIds"] = surface_ids
    validation["rejectedCadComponentIds"] = unavailable_ids

    engineering = {
        "status": "unverified",
        "manufacturingReadiness": "not_established",
        "materials": "unknown",
        "manufacturingTolerances": "unknown",
        "loadsAndConstraints": "not_verified",
        "renderDimensionComparison": {
            "maximumErrorMm": validation["maxDimensionalErrorMm"],
            "thresholdMm": 0.1,
            "meaning": "CAD to render bounds comparison; not manufacturing tolerance",
        },
        "nodeMappingComplete": validation["nodeMappingComplete"],
        "rejectedCadComponentIds": unavailable_ids,
        "surfaceComponentIds": surface_ids,
    }
    result["engineeringReport"] = engineering
    validation["engineeringReport"] = engineering
    (output_dir / "engineering.json").write_text(json.dumps(engineering, indent=2))

    result["verificationStatus"] = "unverified"
    validation["valid"] = False
    validation["sourceInspection"] = True
    validation["failures"].append(
        "Source CAD inspection only; engineering validation and assembly instructions are not established"
    )
    (output_dir / "pipeline_result.json").write_text(json.dumps(result, indent=2))
    return result
