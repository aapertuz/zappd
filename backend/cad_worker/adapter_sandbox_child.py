from __future__ import annotations

import json
import resource
import runpy
import sys
from pathlib import Path


def main() -> None:
    cpu_limit = int(sys.argv[1])
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_limit, cpu_limit + 1))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (128 * 1024**2, 128 * 1024**2))
    from build123d import Compound, Part, Solid, export_step
    from OCP.BRepCheck import BRepCheck_Analyzer

    build_part = runpy.run_path("adapter.py")["build_part"]
    part = build_part(json.loads(Path("params.json").read_text(encoding="utf-8")))
    if not isinstance(part, (Part, Compound, Solid)) or part.wrapped is None:
        raise ValueError("build_part must return a build123d Part or Compound")
    if not part.solids() or len(part.faces()) < 4 or not BRepCheck_Analyzer(part.wrapped).IsValid():
        raise ValueError("Adapter did not produce a valid BRep solid with at least four faces")
    if not export_step(part, "part.step", timestamp="2026-01-01T00:00:00"):
        raise RuntimeError("Could not export adapter STEP")


if __name__ == "__main__":
    main()
