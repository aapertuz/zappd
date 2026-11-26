from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from tempfile import TemporaryDirectory
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from catalog_specs import CATALOG_SPECS, resolve_catalog_spec
from geometry_pipeline import run_cad_pipeline


def _collect_forbidden_roots(repo_root: Path) -> tuple[Path, ...]:
    base_roots = (
        repo_root / "backend" / "data" / "exports",
        repo_root / "public" / "assemblies",
    )
    roots: list[Path] = []
    for base in base_roots:
        roots.extend((base.resolve(), base.absolute()))
        if base.exists():
            for child in base.iterdir():
                roots.extend((child.resolve(), child.absolute()))
    return tuple(dict.fromkeys(roots))


def _is_within_forbidden_root(path_arg: Path, forbidden_roots: tuple[Path, ...]) -> bool:
    for candidate in (path_arg.resolve(), path_arg.absolute()):
        for ancestor in (candidate, *candidate.parents):
            for root in forbidden_roots:
                if ancestor == root or str(ancestor).casefold() == str(root).casefold():
                    return True
                if ancestor.exists() and root.exists() and os.path.samefile(ancestor, root):
                    return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Zappd OpenCascade CAD pipeline CLI")
    parser.add_argument("--archetype", required=False, default="quadcopter_drone_v1")
    parser.add_argument("--all-archetypes", action="store_true")
    parser.add_argument("--output-dir", required=False)
    parser.add_argument("--public-dir", required=False)
    parser.add_argument("--cache-dir", required=False)
    parser.add_argument("--catalog-json", required=False)
    parser.add_argument("--source-archive", required=False)
    parser.add_argument("--download-source", action="store_true")
    parser.add_argument("--params-json", type=json.loads)
    parser.add_argument("--xbf-cache-dir", type=Path)
    parser.add_argument("--render-views-dir", type=Path)
    parser.add_argument("--json-out", required=False)
    parser.add_argument("--inject-collision-test", action="store_true")
    args = parser.parse_args()
    if args.params_json is not None and not isinstance(args.params_json, dict):
        parser.error("--params-json requires a JSON object")

    repo_root = Path(__file__).resolve().parents[2]
    cache_dir = Path(args.cache_dir) if args.cache_dir else repo_root / "backend" / "data" / "open_step_cache"

    if args.inject_collision_test:
        if args.all_archetypes or args.public_dir:
            parser.error("--inject-collision-test cannot be combined with --all-archetypes or --public-dir")
        if not args.output_dir:
            parser.error("--inject-collision-test requires an explicit --output-dir outside canonical exports")
        forbidden_roots = _collect_forbidden_roots(repo_root)
        out_path = Path(args.output_dir)
        checked_paths = [out_path]
        if args.json_out:
            checked_paths.append(Path(args.json_out))
        for path_arg in checked_paths:
            if _is_within_forbidden_root(path_arg, forbidden_roots):
                parser.error(
                    "--inject-collision-test paths must be outside canonical exports and public assemblies"
                )
        if out_path.is_symlink() or (
            out_path.exists() and (not out_path.is_dir() or any(out_path.iterdir()))
        ):
            parser.error("--inject-collision-test --output-dir must be a new or empty directory")
        if args.json_out:
            json_path = Path(args.json_out)
            if json_path.is_symlink() or json_path.exists():
                parser.error("--inject-collision-test --json-out must not already exist")

    targets = list(CATALOG_SPECS.keys()) if args.all_archetypes else [args.archetype]
    if args.all_archetypes and (args.source_archive or args.download_source):
        targets.append("dual_scorpion_v1")
    results = []
    for archetype_id in targets:
        out_dir = (
            Path(args.output_dir)
            if args.output_dir and not args.all_archetypes
            else repo_root / "backend" / "data" / "exports" / archetype_id
        )
        if archetype_id == "dual_scorpion_v1":
            from dual_scorpion_catalog import CATALOG_PATH, download_pinned_archive, prepare_pinned_source

            catalog_path = Path(args.catalog_json) if args.catalog_json else CATALOG_PATH
            if args.source_archive and args.download_source:
                raise ValueError("Choose either --source-archive or --download-source")
            if args.source_archive:
                spec = prepare_pinned_source(Path(args.source_archive), cache_dir, catalog_path)
            elif args.download_source:
                with TemporaryDirectory(prefix="zappd-dual-scorpion-") as temporary:
                    source_archive = download_pinned_archive(Path(temporary) / "dual_scorpion.zip")
                    spec = prepare_pinned_source(source_archive, cache_dir, catalog_path)
            else:
                raise ValueError("Dual Scorpion source inspection needs --source-archive or --download-source")
        else:
            spec = resolve_catalog_spec(archetype_id, args.catalog_json)
        pipeline = run_cad_pipeline
        if archetype_id == "poppy_humanoid_v1":
            from poppy_pipeline import run_poppy_pipeline
            pipeline = run_poppy_pipeline
        elif archetype_id == "dual_scorpion_v1":
            from dual_scorpion_pipeline import run_dual_scorpion_pipeline
            pipeline = run_dual_scorpion_pipeline
        if archetype_id == "dual_scorpion_v1":
            result = pipeline(
                spec,
                output_dir=out_dir,
                cache_dir=cache_dir,
                inject_collision_test=args.inject_collision_test,
            )
        else:
            result = pipeline(
                spec,
                output_dir=out_dir,
                cache_dir=cache_dir,
                inject_collision_test=args.inject_collision_test,
                parameter_overrides=args.params_json,
                xbf_cache_dir=args.xbf_cache_dir,
                render_views_dir=args.render_views_dir,
            )
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "pipeline_result.json").write_text(
            json.dumps(result, indent=2), encoding="utf-8"
        )
        if args.public_dir or args.all_archetypes:
            pub_base = Path(args.public_dir) if args.public_dir else repo_root / "public" / "assemblies"
            pub_dir = pub_base / result["manifest"]["manifestHash"]
            pub_dir.mkdir(parents=True, exist_ok=True)
            for filename in ("model.glb", "model.step", "model.usdz", "manifest.json", "pipeline_result.json", "interference.json", "engineering.json"):
                source_file = out_dir / filename
                if filename in ("interference.json", "engineering.json") and not source_file.exists():
                    continue
                shutil.copy2(source_file, pub_dir / filename)
        results.append(result)

    payload = results if args.all_archetypes else results[0]
    rendered = json.dumps(payload, indent=2)
    if args.json_out:
        out_json_path = Path(args.json_out)
        out_json_path.parent.mkdir(parents=True, exist_ok=True)
        out_json_path.write_text(rendered, encoding="utf-8")
    else:
        print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
