from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from poppy_catalog import verify_poppy_source


def test_poppy_source_rejects_lfs_pointers_and_changed_downloads() -> None:
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        verify_poppy_source(b"version https://git-lfs.github.com/spec/v1\n")
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        verify_poppy_source(b"ISO-10303-21;untrusted replacement")


def test_poppy_import_rejects_changed_source_before_cad_parsing(tmp_path: Path) -> None:
    from poppy_catalog import import_poppy

    source = tmp_path / "replacement.step"
    source.write_bytes(b"ISO-10303-21;changed source")
    cache = tmp_path / "cache"
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        import_poppy(source, cache)
    assert not cache.exists()


@pytest.mark.parametrize("fail", [False, True])
def test_poppy_stages_all_fixtures_before_publication(tmp_path, monkeypatch, fail):
    import poppy_catalog

    source = tmp_path / "source.step"
    source.write_bytes(b"trusted fixture")
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "existing.step").write_bytes(b"preserved")
    monkeypatch.setattr(poppy_catalog, "verify_poppy_source", lambda payload: None)

    def import_candidate(source_path, staging):
        (staging / "first.step").write_bytes(b"validated fixture")
        if fail:
            raise RuntimeError("second occurrence invalid")
        return {"nodes": [{"id": "first"}]}

    monkeypatch.setattr(poppy_catalog, "_import_poppy", import_candidate)
    if fail:
        with pytest.raises(RuntimeError, match="second occurrence invalid"):
            poppy_catalog.import_poppy(source, cache)
        assert not (cache / "first.step").exists()
    else:
        assert poppy_catalog.import_poppy(source, cache)["nodes"] == [{"id": "first"}]
        assert (cache / "first.step").read_bytes() == b"validated fixture"
    assert (cache / "existing.step").read_bytes() == b"preserved"


def test_poppy_preserves_repeated_occurrences_and_nested_placements(tmp_path, monkeypatch):
    import math
    import poppy_catalog
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.STEPCAFControl import STEPCAFControl_Writer
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDocStd import TDocStd_Document
    from OCP.TopLoc import TopLoc_Location
    from OCP.XCAFDoc import XCAFDoc_DocumentTool
    from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

    document = TDocStd_Document(TCollection_ExtendedString("test"))
    tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    part = tool.AddShape(BRepPrimAPI_MakeBox(2, 4, 6).Shape(), False)
    assembly = tool.NewShape()
    translation = gp_Trsf()
    translation.SetTranslation(gp_Vec(10, 0, 0))
    tool.AddComponent(assembly, part, TopLoc_Location(translation))
    tool.AddComponent(assembly, part, TopLoc_Location())
    root = tool.NewShape()
    rotation = gp_Trsf()
    rotation.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), math.pi / 2)
    rotation.SetTranslationPart(gp_Vec(100, 0, 0))
    tool.AddComponent(root, assembly, TopLoc_Location(rotation))
    tool.UpdateAssemblies()
    source = tmp_path / "assembly.step"
    writer = STEPCAFControl_Writer()
    writer.Transfer(document)
    writer.Write(str(source))
    monkeypatch.setattr(poppy_catalog, "verify_poppy_source", lambda payload: None)
    catalog = poppy_catalog.import_poppy(source, tmp_path / "cache")
    parts = [node for node in catalog["nodes"] if node["stepFixtureName"]]
    assert len(parts) == 2
    assert parts[0]["id"] != parts[1]["id"]
    assert parts[0]["parentId"] == parts[1]["parentId"]
    assert parts[0]["restPositionMeters"] == pytest.approx([0.098, 0.011, 0.003])
    assert parts[1]["restPositionMeters"] == pytest.approx([0.098, 0.001, 0.003])
    assert parts[0]["dimensionsMm"] == [4.0, 6.0, 2.0]
    repeated = poppy_catalog.import_poppy(source, tmp_path / "cache_repeat")
    repeated_parts = [node for node in repeated["nodes"] if node["stepFixtureName"]]
    assert [part["expectedStepSha256"] for part in repeated_parts] == [
        part["expectedStepSha256"] for part in parts
    ]


def test_invalid_poppy_occurrence_retains_identity_without_export(tmp_path, monkeypatch):
    import poppy_catalog
    class RejectTopology:
        def __init__(self, shape):
            self.shape = shape

        def IsValid(self):
            return False

    monkeypatch.setattr(poppy_catalog, "BRepCheck_Analyzer", RejectTopology)
    monkeypatch.setattr(poppy_catalog, "verify_poppy_source", lambda payload: None)
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.STEPCAFControl import STEPCAFControl_Writer
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFDoc import XCAFDoc_DocumentTool

    document = TDocStd_Document(TCollection_ExtendedString("rejection"))
    tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    tool.AddShape(BRepPrimAPI_MakeBox(2, 4, 6).Shape(), False)
    writer = STEPCAFControl_Writer()
    writer.Transfer(document)
    source = tmp_path / "source.step"
    writer.Write(str(source))
    catalog = poppy_catalog.import_poppy(source, tmp_path / "cache")
    node = catalog["nodes"][0]
    assert node["id"] == "poppy_1"
    assert node["geometry"]["kind"] == "unavailable"
    assert node["stepFixtureName"] is None
    assert "expectedStepSha256" not in node
    assert not list((tmp_path / "cache").glob("*.step"))


def test_partial_pipeline_exports_only_available_source_geometry(tmp_path):
    import copy
    from catalog_specs import CATALOG_SPECS
    from poppy_pipeline import run_poppy_pipeline

    source = CATALOG_SPECS["quadcopter_drone_v1"]["nodes"]
    nodes = copy.deepcopy([node for node in source if node["id"] in ("proj_quadcopter", "sub_chassis", "comp_base_plate_lower")])
    for node in nodes:
        node["geometry"] = {"kind": "available", "role": "solid"} if node["stepFixtureName"] else {"kind": "assembly"}
        node["specifications"]["sourceSha256"] = "a" * 64
    rejected = copy.deepcopy(next(node for node in nodes if node["stepFixtureName"]))
    rejected.update(id="rejected_head", name="head_face", stepFixtureName=None, geometry={"kind": "unavailable", "reason": "Invalid source topology"})
    nodes.append(rejected)
    result = run_poppy_pipeline({"archetypeId": "poppy_humanoid_v1", "nodes": nodes}, tmp_path / "exports", tmp_path / "cache")
    assert result["verificationStatus"] == "unverified"
    engineering = result["engineeringReport"]
    assert engineering["manufacturingReadiness"] == "not_established"
    assert engineering["manufacturingTolerances"] == "unknown"
    assert engineering["materials"] == "unknown"
    assert engineering["renderDimensionComparison"]["thresholdMm"] == 0.1
    assert engineering["rejectedCadComponentIds"] == ["rejected_head"]
    assert engineering["sourceComponents"][0]["componentId"] == "comp_base_plate_lower"
    assert (tmp_path / "exports/engineering.json").exists()
    assert result["validation"]["valid"] is False
    assert result["validation"]["brepValid"] is True
    assert result["validation"]["nodeMappingComplete"] is True
    assert result["validation"]["interferenceCheck"] == "partial"
    assert result["validation"]["sourceInterferenceReport"]["excludedComponents"][0]["componentId"] == "rejected_head"
    assert result["validation"]["availableGeometryCount"] == 1
    assert result["validation"]["unavailableComponentIds"] == ["rejected_head"]
    assert result["glbNodeIds"] == ["comp_base_plate_lower"]
    assert any(node["id"] == "rejected_head" and node["geometry"]["kind"] == "unavailable" for node in result["nodes"])
    assert all(node["provenance"]["verificationStatus"] == "unverified" for node in result["nodes"])


def test_default_ingest_cleanup_preserves_poppy_fixtures(tmp_path: Path) -> None:
    from ingest_upstream_catalog import clean_default_step_fixtures

    for name in (
        "drone_cad_base_lower.step",
        "so100_base_housing.step",
        "nova2_chassis_plate.step",
        "poppy_1_1_1.step",
        "Poppy_Humanoid.STEP",
    ):
        (tmp_path / name).write_bytes(b"step")

    clean_default_step_fixtures(tmp_path)
    remaining = sorted(path.name for path in tmp_path.iterdir())
    assert remaining == ["Poppy_Humanoid.STEP", "poppy_1_1_1.step"]


def test_poppy_inject_collision_test_recomputes_shifted_interference(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import copy
    import poppy_pipeline
    from catalog_specs import CATALOG_SPECS

    def fail_if_cached_used(_spec, _cache):
        raise AssertionError("cached interference report must not be reused during inject_collision_test")

    monkeypatch.setattr(poppy_pipeline, "load_cached_report", fail_if_cached_used)
    source = CATALOG_SPECS["quadcopter_drone_v1"]["nodes"]
    root = copy.deepcopy(source[0])
    first = copy.deepcopy(next(node for node in source if node["id"] == "comp_base_plate_lower"))
    second = copy.deepcopy(next(node for node in source if node["id"] == "comp_base_plate_upper"))
    first["parentId"] = root["id"]
    first["depth"] = 1
    second["parentId"] = root["id"]
    second["depth"] = 1
    second["restPositionMeters"] = [first["restPositionMeters"][0] + 0.5, first["restPositionMeters"][1], first["restPositionMeters"][2]]
    for node in (root, first, second):
        node["geometry"] = {"kind": "available", "role": "solid"} if node["stepFixtureName"] else {"kind": "assembly"}
        node["specifications"]["sourceSha256"] = "a" * 64

    result = poppy_pipeline.run_poppy_pipeline(
        {"archetypeId": "poppy_humanoid_v1", "semantics": "source_inspection", "nodes": [root, first, second]},
        tmp_path / "exports",
        tmp_path / "cache",
        inject_collision_test=True,
    )
    shifted = next(node for node in result["nodes"] if node["id"] == second["id"])
    assert shifted["restPositionMeters"] == first["restPositionMeters"]
    report = result["validation"]["sourceInterferenceReport"]
    assert report["intersectionCount"] == 1
    assert result["validation"]["interferenceCount"] == 1


def test_cli_rejects_inject_collision_test_into_canonical_exports(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import cli

    repo_root = Path(__file__).resolve().parents[3]
    canonical_export = repo_root / "backend" / "data" / "exports" / "poppy_humanoid_v1"
    canonical_public = repo_root / "public" / "assemblies" / "poppy_humanoid_v1"
    for argv in (
        ["cli.py", "--archetype", "poppy_humanoid_v1", "--inject-collision-test"],
        ["cli.py", "--archetype", "poppy_humanoid_v1", "--inject-collision-test", "--output-dir", str(canonical_export)],
        ["cli.py", "--archetype", "poppy_humanoid_v1", "--inject-collision-test", "--output-dir", str(canonical_public)],
        ["cli.py", "--archetype", "poppy_humanoid_v1", "--inject-collision-test", "--output-dir", str(tmp_path), "--json-out", str(canonical_export / "pipeline_result.json")],
        ["cli.py", "--archetype", "poppy_humanoid_v1", "--inject-collision-test", "--output-dir", str(tmp_path), "--json-out", str(canonical_public / "pipeline_result.json")],
        ["cli.py", "--archetype", "poppy_humanoid_v1", "--inject-collision-test", "--output-dir", str(tmp_path), "--public-dir", str(tmp_path / "pub")],
        ["cli.py", "--all-archetypes", "--inject-collision-test", "--output-dir", str(tmp_path)],
    ):
        monkeypatch.setattr(sys, "argv", argv)
        with pytest.raises(SystemExit) as exc:
            cli.main()
        assert exc.value.code == 2
