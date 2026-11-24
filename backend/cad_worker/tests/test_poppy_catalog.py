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
