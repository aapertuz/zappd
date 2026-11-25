import copy

import pytest
from pathlib import Path

from poppy_interference import load_cached_report


def test_changed_catalog_never_reuses_report(tmp_path):
    assert load_cached_report({'nodes': []}, tmp_path) is None


def test_current_catalog_requires_all_fixture_digests(tmp_path):
    import json
    catalog = Path(__file__).parents[2] / 'data' / 'poppy-catalog.json'
    if not catalog.exists():
        pytest.skip("Local pinned catalog is unavailable")
    spec = json.loads(catalog.read_text())
    assert load_cached_report(copy.deepcopy(spec), tmp_path) is None
