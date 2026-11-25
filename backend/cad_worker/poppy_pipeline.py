import json
from copy import deepcopy
from pathlib import Path

from geometry_pipeline import run_cad_pipeline
from poppy_visual import HEAD_ID, load_head_visual, visual_state


def run_poppy_pipeline(
    spec: dict,
    output_dir: Path,
    cache_dir: Path,
    inject_collision_test: bool = False,
) -> dict:
    spec = deepcopy(spec)
    head = next((node for node in spec["nodes"] if node["id"] == HEAD_ID), None)
    visual_geometry = {}
    if head is not None:
        cad_reason = head["geometry"]["reason"]
        visual_geometry[HEAD_ID] = load_head_visual(cache_dir, head["restPositionMeters"])
        head["geometry"] = visual_state(cad_reason)
    result = run_cad_pipeline(
        spec, output_dir, cache_dir, inject_collision_test, check_interference=False,
        visual_geometry_by_id=visual_geometry,
    )
    by_id = {node["id"]: node for node in result["nodes"]}
    for source in spec["nodes"]:
        node = by_id[source["id"]]
        node["geometry"] = source["geometry"]
        node["provenance"]["verificationStatus"] = "unverified"
        if source["geometry"]["kind"] in ("unavailable", "visual_only"):
            node["provenance"]["stepSha256"] = source["specifications"]["sourceSha256"]
    expected_geometry = {
        node["id"] for node in spec["nodes"]
        if node["geometry"]["kind"] in ("available", "visual_only")
    }
    excluded_geometry = {
        node["id"] for node in spec["nodes"]
        if node["geometry"]["kind"] == "unavailable"
    }
    if set(result["glbNodeIds"]) != expected_geometry:
        raise RuntimeError("Poppy geometry coverage differs from source validation states")
    validation = result["validation"]
    validation["interferenceCheck"] = "not_performed"
    validation["availableGeometryCount"] = len(expected_geometry) - len(visual_geometry)
    validation["visualOnlyComponentIds"] = list(visual_geometry)
    validation["rejectedCadComponentIds"] = sorted(excluded_geometry | set(visual_geometry))
    result["manifest"]["componentGeometry"] = {head["id"]: head["geometry"]} if head else {}
    (output_dir / "manifest.json").write_text(json.dumps(result["manifest"], indent=2))
    validation["unavailableComponentIds"] = sorted(excluded_geometry)
    validation["surfaceComponentIds"] = [
        node["id"] for node in spec["nodes"]
        if node["geometry"].get("role") == "surface"
    ]
    result["verificationStatus"] = "unverified"
    validation["valid"] = False
    validation["failures"].append(
        "Partial source inspection: head_face uses official visual-only STL; source CAD remains rejected; "
        "engineering validation not established"
    )
    (output_dir / "pipeline_result.json").write_text(json.dumps(result, indent=2))
    return result
