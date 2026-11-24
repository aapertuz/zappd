import json
from pathlib import Path

from geometry_pipeline import run_cad_pipeline


def run_poppy_pipeline(
    spec: dict,
    output_dir: Path,
    cache_dir: Path,
    inject_collision_test: bool = False,
) -> dict:
    result = run_cad_pipeline(
        spec, output_dir, cache_dir, inject_collision_test, check_interference=False
    )
    by_id = {node["id"]: node for node in result["nodes"]}
    for source in spec["nodes"]:
        node = by_id[source["id"]]
        node["geometry"] = source["geometry"]
        node["provenance"]["verificationStatus"] = "unverified"
        if source["geometry"]["kind"] == "unavailable":
            node["provenance"]["stepSha256"] = source["specifications"]["sourceSha256"]
    expected_geometry = {
        node["id"] for node in spec["nodes"]
        if node["geometry"]["kind"] == "available"
    }
    excluded_geometry = {
        node["id"] for node in spec["nodes"]
        if node["geometry"]["kind"] == "unavailable"
    }
    if set(result["glbNodeIds"]) != expected_geometry:
        raise RuntimeError("Poppy geometry coverage differs from source validation states")
    validation = result["validation"]
    validation["interferenceCheck"] = "not_performed"
    validation["availableGeometryCount"] = len(expected_geometry)
    validation["unavailableComponentIds"] = sorted(excluded_geometry)
    validation["surfaceComponentIds"] = [
        node["id"] for node in spec["nodes"]
        if node["geometry"].get("role") == "surface"
    ]
    result["verificationStatus"] = "unverified"
    validation["valid"] = False
    validation["failures"].append(
        "Partial source inspection: head_face geometry unavailable; "
        "engineering validation not established"
    )
    (output_dir / "pipeline_result.json").write_text(json.dumps(result, indent=2))
    return result
