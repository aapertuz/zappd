import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from poppy_interference import load_cached_report
from poppy_catalog import POPPY_SPEC_PATH


def test_changed_catalog_never_reuses_report(tmp_path):
    assert load_cached_report({'nodes': []}, tmp_path) is None


def test_current_catalog_rejects_a_changed_fixture_in_the_active_cache(tmp_path):
    spec = json.loads(POPPY_SPEC_PATH.read_text())
    fixture = next(node["stepFixtureName"] for node in spec["nodes"] if node["stepFixtureName"])
    (tmp_path / fixture).write_bytes(b"changed")
    assert load_cached_report(copy.deepcopy(spec), tmp_path) is None


def test_current_catalog_falls_back_to_the_repository_fixture_caches(tmp_path):
    spec = json.loads(POPPY_SPEC_PATH.read_text())
    report = load_cached_report(copy.deepcopy(spec), tmp_path)
    assert report is not None
    assert report["solidCount"] == 249
