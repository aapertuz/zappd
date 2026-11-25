from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from catalog_specs import CATALOG_SPECS, resolve_catalog_spec
from geometry_pipeline import run_cad_pipeline


def main() -> int:
    parser = argparse.ArgumentParser(description="Zappd OpenCascade CAD pipeline CLI")
    parser.add_argument("--archetype", required=False, default="quadcopter_drone_v1")
    parser.add_argument("--all-archetypes", action="store_true")
    parser.add_argument("--output-dir", required=False)
    parser.add_argument("--public-dir", required=False)
    parser.add_argument("--cache-dir", required=False)
    parser.add_argument("--catalog-json", required=False)
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

    targets = list(CATALOG_SPECS.keys()) if args.all_archetypes else [args.archetype]
    results = []
    for archetype_id in targets:
        out_dir = (
            Path(args.output_dir)
            if args.output_dir and not args.all_archetypes
            else repo_root / "backend" / "data" / "exports" / archetype_id
        )
        spec = resolve_catalog_spec(archetype_id, args.catalog_json)
        result = run_cad_pipeline(
            spec,
            output_dir=out_dir,
            cache_dir=cache_dir,
            inject_collision_test=args.inject_collision_test,
            parameter_overrides=args.params_json,
            xbf_cache_dir=args.xbf_cache_dir,
            render_views_dir=args.render_views_dir,
        )
        if args.public_dir or args.all_archetypes:
            pub_base = Path(args.public_dir) if args.public_dir else repo_root / "public" / "assemblies"
            pub_dir = pub_base / result["manifest"]["manifestHash"]
            pub_dir.mkdir(parents=True, exist_ok=True)
            for filename in ("model.glb", "model.step", "model.usdz", "manifest.json", "pipeline_result.json"):
                shutil.copy2(out_dir / filename, pub_dir / filename)
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
