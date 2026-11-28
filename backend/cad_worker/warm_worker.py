from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import TextIO

sys.path.insert(0, str(Path(__file__).resolve().parent))

from catalog_specs import resolve_catalog_spec
from geometry_pipeline import run_cad_pipeline
from xbf_cache import DEFAULT_XBF_DIR, CadAssetCache


def _build(request: dict, cache: CadAssetCache) -> dict:
    if request["cmd"] == "rebuild_params" and "parameterValues" not in request:
        raise ValueError("rebuild_params requires parameterValues")
    params = request.get("parameterValues")
    if params is not None and not isinstance(params, dict):
        raise ValueError("parameterValues must be an object")
    inject_collision = request.get("injectCollisionTest", False)
    if not isinstance(inject_collision, bool):
        raise ValueError("injectCollisionTest must be a boolean")
    render_dir = request.get("renderViewsDir")
    archetype_id = request["archetypeId"]
    output_dir = Path(request["outputDir"])
    cache_dir = Path(request["cacheDir"])
    spec = resolve_catalog_spec(archetype_id)
    pipeline = run_cad_pipeline
    if archetype_id == "poppy_humanoid_v1":
        from poppy_pipeline import run_poppy_pipeline

        pipeline = run_poppy_pipeline
    elif archetype_id == "dual_scorpion_v1":
        from dual_scorpion_catalog import CATALOG_PATH, download_pinned_archive, prepare_pinned_source
        from dual_scorpion_pipeline import run_dual_scorpion_pipeline

        cache_dir.mkdir(parents=True, exist_ok=True)
        archive_path = cache_dir / "dual_scorpion_source.zip"
        if not archive_path.is_file():
            download_pinned_archive(archive_path)
        spec = prepare_pinned_source(archive_path, cache_dir, CATALOG_PATH)
        pipeline = run_dual_scorpion_pipeline
    return pipeline(
        spec,
        output_dir,
        cache_dir,
        inject_collision_test=inject_collision,
        asset_cache=cache,
        parameter_overrides=params,
        render_views_dir=Path(render_dir) if render_dir else None,
    )


def serve(source: TextIO, destination: TextIO, cache: CadAssetCache) -> None:
    for line in source:
        request_id = None
        stop = False
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Expected a JSON request object")
            request_id = request["id"]
            command = request["cmd"]
            if command == "ping":
                response = {"pid": os.getpid()}
            elif command in {"build", "rebuild_params"}:
                response = {"result": _build(request, cache)}
            elif command == "shutdown":
                response, stop = {}, True
            else:
                raise ValueError(f"Unknown worker command: {command}")
            reply = {"id": request_id, "ok": True, **response}
        except Exception as error:
            reply = {"id": request_id, "ok": False, "error": str(error)}
        destination.write(json.dumps(reply, separators=(",", ":")) + "\n")
        destination.flush()
        if stop:
            break


def main() -> None:
    parser = argparse.ArgumentParser(description="Persistent Zappd CAD worker")
    parser.add_argument("--xbf-cache-dir", type=Path, default=DEFAULT_XBF_DIR)
    args = parser.parse_args()
    with os.fdopen(os.dup(sys.stdout.fileno()), "w") as protocol:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        serve(sys.stdin, protocol, CadAssetCache(args.xbf_cache_dir))


if __name__ == "__main__":
    main()
