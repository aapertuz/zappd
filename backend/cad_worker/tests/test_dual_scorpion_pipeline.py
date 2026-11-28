from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import dual_scorpion_pipeline


def test_source_reports_are_written_and_incomplete_pairs_remain_unverified(
    tmp_path: Path, monkeypatch
) -> None:
    source = {
        "nodes": [
            {"id": "assembly", "geometry": {"kind": "assembly"}},
            {
                "id": "available_part",
                "geometry": {"kind": "available", "role": "solid"},
                "specifications": {"sourceSha256": "a" * 64},
            },
            {
                "id": "available_part_2",
                "geometry": {"kind": "available", "role": "solid"},
                "specifications": {"sourceSha256": "c" * 64},
            },
            {
                "id": "rejected_part",
                "geometry": {"kind": "unavailable", "reason": "invalid source topology"},
                "specifications": {"sourceSha256": "b" * 64},
            },
        ]
    }
    result = {
        "nodes": [
            {
                "id": node["id"],
                "geometry": node["geometry"],
                "provenance": {"verificationStatus": "sourced_verified"},
            }
            for node in source["nodes"]
        ],
        "validation": {
            "valid": False,
            "brepValid": True,
            "nodeMappingComplete": True,
            "interferenceCount": 0,
            "maxDimensionalErrorMm": 0.04,
            "availableGeometryCount": 1,
            "failures": ["Volumetric interference analysis not performed for source inspection"],
        },
        "verificationStatus": "unverified",
    }
    report = {
        "status": "partial",
        "method": "source placement AABB then OCCT common",
            "solidCount": 2,
        "excludedComponents": [{"componentId": "rejected_part", "reason": "invalid source topology"}],
        "sourceComponents": [],
            "possiblePairCount": 1,
            "candidatePairCount": 1,
        "volumeThresholdMm3": 0.001,
        "aabbToleranceMm": 1e-7,
        "timeoutSecondsPerPair": 30,
            "pairs": [
                {
                    "componentIds": ["available_part", "available_part_2"],
                    "status": "timeout",
                    "volumeMm3": None,
                    "error": "Pair worker produced no result within deadline",
                }
            ],
        "intersectionCount": 0,
            "unresolvedPairCount": 1,
        "limitations": ["Excluded CAD is not clear of interference"],
    }
    monkeypatch.setattr(dual_scorpion_pipeline, "run_cad_pipeline", lambda *args, **kwargs: result)
    monkeypatch.setattr(dual_scorpion_pipeline, "analyze", lambda spec, cache: report)

    output_dir = tmp_path / "export"
    exported = dual_scorpion_pipeline.run_dual_scorpion_pipeline(
        source, output_dir, tmp_path / "cache"
    )

    assert exported["verificationStatus"] == "unverified"
    assert exported["validation"]["valid"] is False
    assert exported["validation"]["sourceInterferenceReport"] == report
    assert exported["validation"]["engineeringReport"]["status"] == "unverified"
    assert exported["validation"]["unavailableComponentIds"] == ["rejected_part"]
    assert exported["nodes"][3]["provenance"]["stepSha256"] == "b" * 64
    assert "Source interference report contains overlaps or unresolved pairs" in exported["validation"]["failures"]
    assert json.loads((output_dir / "interference.json").read_text()) == report
    assert json.loads((output_dir / "engineering.json").read_text()) == exported["engineeringReport"]
    assert json.loads((output_dir / "pipeline_result.json").read_text()) == exported
