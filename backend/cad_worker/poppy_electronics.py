from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory

from cable_router import route_harness_for_node
from catalog_ingestor import REPO_STEP_CACHE_DIR
from poppy_catalog import POPPY_SOURCE_SHA256, POPPY_SOURCE_URL, POPPY_SPEC_PATH

CATALOG_DIRECTORY = POPPY_SPEC_PATH.parents[1]
OVERLAY_PATH = CATALOG_DIRECTORY / "sources" / "poppy_humanoid_electronics.json"
INTERFERENCE_PATH = Path(__file__).parent / "tests" / "evidence" / "poppy-interference.json"
ELECTRONICS_ID = "sub_poppy_electronics"
WIRING_ID = "sub_poppy_wiring"
LICENSE = "CC-BY-SA-4.0"


def overlay_node(node_id, name, parent_id, category, origin, source_url, source_name, **fields):
    return {
        "id": node_id,
        "geometry": {"kind": "available", "role": "solid"},
        "parentId": parent_id,
        "name": name,
        "level": "component",
        "depth": 2,
        "category": category,
        "colorHex": "#cbd5e1",
        "materialHint": "unspecified",
        "explodeDirection": [0.0, 0.0, -1.0],
        "explodeDistanceMeters": 0.035,
        "origin": origin,
        "spdxLicense": LICENSE,
        "sourceUrl": source_url,
        "sourceName": source_name,
        **fields,
    }


def subsystem_node(placement, root_id):
    return overlay_node(
        placement["id"], placement["name"], root_id, "assembly", "open_step_catalog",
        POPPY_SOURCE_URL, "Poppy Humanoid 1.0.2 electronics inspection",
        geometry={"kind": "assembly"},
        level="subsystem",
        depth=1,
        restPositionMeters=[0.0, 0.0, 0.0],
        dimensionsMm=[0.0, 0.0, 0.0],
        stepFixtureName=None,
        specifications={"sourceSha256": POPPY_SOURCE_SHA256},
    )


def board_node(placement, fixture):
    port_overrides = placement.get("portOverrides", {})
    ports = [
        {**port, **port_overrides.get(port["portId"], {})}
        for port in fixture["ports"]
    ]
    x, y, z = fixture["dimensionsMm"]
    return overlay_node(
        placement["id"], placement["name"], ELECTRONICS_ID, "electronics",
        fixture["origin"], fixture["sourceUrl"], fixture["sourceName"],
        restPositionMeters=placement["restPositionMeters"],
        dimensionsMm=[x, z, y],
        colorHex=fixture["colorHex"],
        materialHint=fixture["materialHint"],
        stepFixtureName=fixture["stepFixtureName"],
        expectedStepSha256=fixture["expectedStepSha256"],
        specifications={**fixture["specifications"], **placement["specifications"]},
        ports=ports,
    )


def cable_node(cable, archetype_id):
    relationship = cable["relationship"]
    return overlay_node(
        cable["id"], cable["name"], WIRING_ID, "wiring", "procedural_harness",
        f"harness://zappd/{archetype_id}/{relationship['id']}", "Poppy Humanoid inspection routing",
        colorHex="#222428",
        materialHint="silicone_wire",
        stepFixtureName=f"{cable['id']}.step",
        specifications={"relationshipId": relationship["id"], **cable["specifications"]},
    )


def mount_relationship(node_id, mount_id, description):
    return {
        "id": f"rel_poppy_mount_{node_id.removeprefix('comp_poppy_')}",
        "fromComponentId": mount_id,
        "toComponentId": node_id,
        "connectionType": "assembly_mount",
        "howConnected": description,
        "whyConnected": "Locates the reference part in the Poppy inspection assembly.",
    }


def apply_poppy_electronics(spec: dict, cache_dir: Path) -> dict:
    overlay = json.loads(OVERLAY_PATH.read_text())
    registry = {
        part["cotsId"]: part
        for part in json.loads((CATALOG_DIRECTORY / "cots" / "index.json").read_text())
    }
    composed = deepcopy(spec)
    nodes = composed["nodes"] = [
        node for node in composed["nodes"]
        if node["id"] not in {ELECTRONICS_ID, WIRING_ID}
        and node["parentId"] not in {ELECTRONICS_ID, WIRING_ID}
    ]
    by_id = {node["id"]: node for node in nodes}
    for node_id, metadata in overlay["sourcePorts"].items():
        node = by_id[node_id]
        node["specifications"].update(metadata["specifications"])
        node["ports"] = metadata["ports"]

    relationships = composed["relationships"] = [
        relationship for relationship in composed["relationships"]
        if not relationship["id"].startswith(("rel_poppy_wire_", "rel_poppy_mount_"))
    ]
    nodes.extend(subsystem_node(entry, composed["rootNodeId"]) for entry in overlay["subsystems"])
    for placement in overlay["boards"]:
        nodes.append(board_node(placement, registry[placement["cotsId"]]))
        relationships.append(mount_relationship(placement["id"], placement["mountComponentId"], placement["mountDescription"]))
    for cable in overlay["cables"]:
        node = cable_node(cable, composed["archetypeId"])
        nodes.append(node)
        relationships.append(cable["relationship"])
        relationships.append(mount_relationship(
            node["id"], WIRING_ID, "Shows the cable path between its connector endpoints."
        ))
        resolved = route_harness_for_node(node, composed, cache_dir)
        node.update(
            expectedStepSha256=resolved["sha256"],
            restPositionMeters=resolved["restPositionMeters"],
            dimensionsMm=resolved["dimensionsMm"],
        )
    return composed


def verify_clear(spec, cache_dir, previous_report=None):
    from poppy_interference import analyze

    report = analyze(spec, cache_dir, previous_report=previous_report)
    added_ids = {
        node["id"] for node in spec["nodes"]
        if node["origin"] in {"kicad_pcb_step", "procedural_harness"}
    }
    invalid_pairs = [
        pair for pair in report["pairs"]
        if added_ids.intersection(pair["componentIds"]) and pair["status"] != "contact_or_below_threshold"
    ]
    if invalid_pairs:
        raise RuntimeError(f"Poppy electronics interference or unresolved pairs: {invalid_pairs}")
    return report


def write_catalog_json(spec, path: Path):
    output = subprocess.run(
        ("pnpm", "exec", "prettier", "--stdin-filepath", str(path)),
        cwd=CATALOG_DIRECTORY.parents[3], input=json.dumps(spec),
        text=True, check=True, capture_output=True,
    ).stdout
    with TemporaryDirectory(dir=path.parent) as directory:
        staged = Path(directory) / path.name
        staged.write_text(output)
        staged.replace(path)


def main():
    parser = argparse.ArgumentParser(description="Compose Poppy Humanoid electronics and routed STEP fixtures.")
    parser.add_argument("--cache-dir", type=Path, default=REPO_STEP_CACHE_DIR)
    parser.add_argument("--verify-clear", action="store_true")
    args = parser.parse_args()
    spec = apply_poppy_electronics(json.loads(POPPY_SPEC_PATH.read_text()), args.cache_dir)
    report = None
    if args.verify_clear:
        previous = json.loads(INTERFERENCE_PATH.read_text()) if INTERFERENCE_PATH.is_file() else None
        report = verify_clear(spec, args.cache_dir, previous)
    write_catalog_json(spec, POPPY_SPEC_PATH)
    if report is not None:
        report["catalogSha256"] = hashlib.sha256(POPPY_SPEC_PATH.read_bytes()).hexdigest()
        write_catalog_json(report, INTERFERENCE_PATH)


if __name__ == "__main__":
    main()
