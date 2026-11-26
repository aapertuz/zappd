from __future__ import annotations

from pathlib import Path
from typing import Any

from geometry_pipeline import run_cad_pipeline


def run_dual_scorpion_pipeline(
    spec: dict[str, Any],
    output_dir: Path,
    cache_dir: Path,
    inject_collision_test: bool = False,
) -> dict[str, Any]:
    result = run_cad_pipeline(
        spec,
        output_dir,
        cache_dir,
        inject_collision_test=inject_collision_test,
        check_interference=False,
    )
    result_nodes = {node["id"]: node for node in result["nodes"]}
    for source_node in spec["nodes"]:
        node = result_nodes[source_node["id"]]
        node["geometry"] = source_node["geometry"]
        node["provenance"]["verificationStatus"] = "unverified"
        if source_node["geometry"]["kind"] == "unavailable":
            node["provenance"]["stepSha256"] = source_node["specifications"]["sourceSha256"]

    result["verificationStatus"] = "unverified"
    result["validation"]["valid"] = False
    result["validation"]["failures"].append(
        "Source CAD inspection only; mechanical engineering validation and assembly instructions are not established"
    )
    result["validation"]["availableGeometryCount"] = sum(
        node["geometry"]["kind"] == "available" for node in spec["nodes"]
    )
    result["validation"]["unavailableComponentIds"] = sorted(
        node["id"] for node in spec["nodes"] if node["geometry"]["kind"] == "unavailable"
    )
    result["validation"]["sourceInspection"] = True
    return result
