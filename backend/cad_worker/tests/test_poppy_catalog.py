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
    assert parts[0]["restPositionMeters"] == pytest.approx([0.098, 0.003, -0.011])
    assert parts[1]["restPositionMeters"] == pytest.approx([0.098, 0.003, -0.001])
    assert parts[0]["dimensionsMm"] == [4.0, 2.0, 6.0]
