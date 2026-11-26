from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path
from statistics import median
from tempfile import TemporaryDirectory
from time import perf_counter

_WORKER = Path(__file__).with_name("warm_worker.py")


@contextmanager
def worker(xbf_dir: Path):
    with subprocess.Popen(
        [sys.executable, str(_WORKER), "--xbf-cache-dir", str(xbf_dir)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    ) as process:
        def request(**message):
            message["id"] = "benchmark"
            process.stdin.write(json.dumps(message) + "\n")
            process.stdin.flush()
            line = process.stdout.readline()
            if not line:
                raise RuntimeError("CAD worker exited without replying")
            reply = json.loads(line)
            if not reply["ok"]:
                raise RuntimeError(reply["error"])
            return reply

        try:
            yield request
        finally:
            if process.poll() is None:
                request(cmd="shutdown")
                process.wait(timeout=10)


def benchmark(runs: int, work_dir: Path) -> dict:
    samples = defaultdict(list)
    wall = defaultdict(list)
    work_dir.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=work_dir) as job:
        root = Path(job)
        command = {
            "archetypeId": "parametric_multirotor_v1",
            "outputDir": str(root / "output"),
            "cacheDir": str(root / "steps"),
        }

        def measure(call, expected, **request):
            started = perf_counter()
            response = call(**command, **request)["result"]
            elapsed = (perf_counter() - started) * 1000
            validation = response["validation"]
            if not validation["valid"]:
                raise RuntimeError(validation["failures"])
            timing = validation["buildTimingMs"]
            if timing["cacheMode"] != expected:
                raise RuntimeError(f"Expected {expected}, CAD worker reported {timing['cacheMode']}")
            if response["parameterValues"]["wheelbase_mm"] != request["parameterValues"]["wheelbase_mm"]:
                raise RuntimeError("Pipeline did not apply the requested wheelbase")
            samples[expected].append(timing["totalMs"])
            wall[expected].append(elapsed)

        quad = {"rotor_count": 4, "wheelbase_mm": 260, "deck_gap_mm": 26, "arm_thickness_mm": 4}
        hex_rotor = {"rotor_count": 6, "wheelbase_mm": 320, "deck_gap_mm": 30, "arm_thickness_mm": 5}
        with worker(root / "warm-xbf") as warm:
            warm(cmd="ping")
            primed = warm(cmd="build", parameterValues=hex_rotor, **command)["result"]
            if not primed["validation"]["valid"]:
                raise RuntimeError(primed["validation"]["failures"])
            for index in range(runs):
                values = quad if index % 2 == 0 else hex_rotor
                xbf_dir = root / f"sample-{index}"
                with worker(xbf_dir) as cold:
                    measure(cold, "cold_step", cmd="build", parameterValues=values)
                with worker(xbf_dir) as disk:
                    measure(disk, "xbf_disk", cmd="build", parameterValues=values)
                measure(warm, "warm_ram", cmd="rebuild_params", parameterValues=values)

    return {
        "archetypeId": command["archetypeId"],
        "runsPerMode": runs,
        "modes": {
            mode: {
                "medianMs": round(median(times), 3), "minMs": round(min(times), 3),
                "maxMs": round(max(times), 3), "medianRoundTripMs": round(median(wall[mode]), 3),
                "samplesMs": times,
            }
            for mode, times in samples.items()
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark validated Zappd CAD builds")
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--json-out", type=Path)
    args = parser.parse_args()
    if args.runs < 5:
        parser.error("--runs must be at least 5")
    result = benchmark(args.runs, args.work_dir)
    payload = json.dumps(result, indent=2)
    if args.json_out:
        args.json_out.write_text(payload + "\n", encoding="utf-8")
    else:
        print(payload)
    print("| Cache mode | Median ms | Min–max ms | Median worker round trip ms |")
    print("| --- | ---: | ---: | ---: |")
    for mode, timing in result["modes"].items():
        print(f"| {mode} | {timing['medianMs']:.1f} | {timing['minMs']:.1f}–{timing['maxMs']:.1f}"
              f" | {timing['medianRoundTripMs']:.1f} |")


if __name__ == "__main__":
    main()
