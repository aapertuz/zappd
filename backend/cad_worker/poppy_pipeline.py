import json
from copy import deepcopy
from pathlib import Path

from geometry_pipeline import run_cad_pipeline
from poppy_interference import analyze, load_cached_report
from poppy_visual import HEAD_ID, load_head_visual, visual_state


def run_poppy_pipeline(
    spec: dict,
    output_dir: Path,
    cache_dir: Path,
    inject_collision_test: bool = False,
    *,
    asset_cache=None,
    xbf_cache_dir: Path | None = None,
    parameter_overrides: dict | None = None,
    render_views_dir: Path | None = None,
) -> dict:
    del parameter_overrides
    cached_interference = None if inject_collision_test else load_cached_report(spec, cache_dir)
    spec = deepcopy(spec)
    if inject_collision_test and spec["nodes"]:
        first_geom_node = next(
            (node for node in spec["nodes"] if node.get("stepFixtureName") is not None),
            None,
        )
        if first_geom_node is not None and spec["nodes"][-1].get("stepFixtureName") is not None:
            spec["nodes"][-1]["restPositionMeters"] = list(first_geom_node["restPositionMeters"])
    head = next((node for node in spec["nodes"] if node["id"] == HEAD_ID), None)
    visual_geometry = {}
    if head is not None:
        cad_reason = head["geometry"]["reason"]
        visual_geometry[HEAD_ID] = load_head_visual(cache_dir, head["restPositionMeters"])
        head["geometry"] = visual_state(cad_reason)
    result = run_cad_pipeline(
        spec,
        output_dir,
        cache_dir,
        inject_collision_test,
        check_interference=False,
        visual_geometry_by_id=visual_geometry,
        allow_partial_geometry=True,
        asset_cache=asset_cache,
        xbf_cache_dir=xbf_cache_dir,
        render_views_dir=render_views_dir,
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
    interference = cached_interference or analyze(spec, cache_dir)
    validation["interferenceCheck"] = "partial"
    validation["interferenceCount"] = interference["intersectionCount"]
    validation["sourceInterferenceReport"] = interference
    validation["failures"] = [failure for failure in validation["failures"]
                              if failure != "Volumetric interference analysis not performed for source inspection"]
    if interference["intersectionCount"] or interference["unresolvedPairCount"]:
        validation["failures"].append("Source interference report contains overlaps or unresolved pairs")
    (output_dir / "interference.json").write_text(json.dumps(interference, indent=2))
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
        "rejectedCadComponentIds": validation["rejectedCadComponentIds"],
        "surfaceComponentIds": validation["surfaceComponentIds"],
        "interferenceReport": "interference.json",
        "sourceComponents": interference["sourceComponents"],
    }
    result["engineeringReport"] = engineering
    validation["engineeringReport"] = engineering
    (output_dir / "engineering.json").write_text(json.dumps(engineering, indent=2))
    result["verificationStatus"] = "unverified"
    validation["valid"] = False
    validation["failures"].append(
        "Partial source inspection: head_face uses official visual-only STL; source CAD remains rejected; "
        "engineering validation not established"
    )
    (output_dir / "pipeline_result.json").write_text(json.dumps(result, indent=2))
    return result
