from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING, Literal

from OCP.BinXCAFDrivers import BinXCAFDrivers, BinXCAFDrivers_DocumentRetrievalDriver
from OCP.PCDM import PCDM_RS_OK, PCDM_SS_OK
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDocStd import TDocStd_Application, TDocStd_Document
from OCP.TopoDS import TopoDS_Shape

from catalog_ingestor import (
    read_step_digest,
    read_xcaf_document,
    read_xcaf_face_colors,
    validate_step_shape,
    xcaf_shape,
)

if TYPE_CHECKING:
    from geometry_pipeline import MeshGeometry

CacheMode = Literal["warm_ram", "xbf_disk", "cold_step"]
DEFAULT_XBF_DIR = Path(__file__).resolve().parents[1] / "data" / "xbf_cache"
_FORMAT = TCollection_ExtendedString("BinXCAF")


@dataclass(frozen=True)
class CadAsset:
    shape: TopoDS_Shape
    face_colors: list[tuple[TopoDS_Shape, str | None]]
    mesh_geometry: MeshGeometry
    face_count: int
    sha256: str


class CadAssetCache:
    def __init__(self, xbf_cache_dir: Path = DEFAULT_XBF_DIR, max_entries: int = 128):
        self.xbf_cache_dir = xbf_cache_dir
        self.max_entries = max_entries
        self._assets: OrderedDict[tuple[str, str], CadAsset] = OrderedDict()
        self._application = TDocStd_Application()
        BinXCAFDrivers.DefineFormat_s(self._application)

    def load(
        self, step_path: Path, origin: str, expected_sha256: str | None = None
    ) -> tuple[CadAsset, CacheMode]:
        from geometry_pipeline import tessellate_step_geometry

        digest = read_step_digest(step_path, expected_sha256)
        key = (digest, origin)
        if key in self._assets:
            self._assets.move_to_end(key)
            return self._assets[key], "warm_ram"

        xbf_path = self.xbf_cache_dir / f"{digest}.xbf"
        document = self._read_xbf(xbf_path)
        if document is None:
            document = read_xcaf_document(step_path)
            mode: CacheMode = "cold_step"
        else:
            mode = "xbf_disk"

        shape = xcaf_shape(document)
        face_count = validate_step_shape(shape, step_path)
        if mode == "cold_step":
            self._write_xbf(xbf_path, document)

        face_colors = read_xcaf_face_colors(document)
        asset = CadAsset(
            shape, face_colors, tessellate_step_geometry(shape, face_colors, origin), face_count, digest
        )
        self._assets[key] = asset
        if len(self._assets) > self.max_entries:
            self._assets.popitem(last=False)
        return asset, mode

    def _read_xbf(self, path: Path) -> TDocStd_Document | None:
        if not path.is_file():
            return None
        document = TDocStd_Document(_FORMAT)
        driver = BinXCAFDrivers_DocumentRetrievalDriver()
        try:
            driver.Read(TCollection_ExtendedString(str(path)), document, self._application)
        except (RuntimeError, ValueError):
            return None
        return document if driver.GetStatus() == PCDM_RS_OK else None

    def _write_xbf(self, path: Path, document: TDocStd_Document) -> None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with TemporaryDirectory(dir=path.parent) as staging:
                staged = Path(staging) / path.name
                if self._application.SaveAs(document, TCollection_ExtendedString(str(staged))) == PCDM_SS_OK:
                    staged.replace(path)
        except OSError:
            return


def build_cache_mode(modes: list[CacheMode]) -> CacheMode:
    if not modes or "cold_step" in modes:
        return "cold_step"
    return "xbf_disk" if "xbf_disk" in modes else "warm_ram"
