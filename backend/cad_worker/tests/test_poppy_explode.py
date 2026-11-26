import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from poppy_explode import assign_inspection_offsets


def test_offsets_preserve_source_placements_and_handle_coincident_centers():
    nodes = [
        {"id": "root", "parentId": None, "dimensionsMm": [100, 100, 100], "restPositionMeters": [0, 0, 0], "explodeDirection": [0, 0, 0], "explodeDistanceMeters": 0},
        *[{"id": name, "parentId": "root", "dimensionsMm": [10, 10, 10], "restPositionMeters": [0, 0, 0]} for name in ["left", "right"]],
    ]
    original = copy.deepcopy(nodes)
    assign_inspection_offsets(nodes)
    assert [n["restPositionMeters"] for n in nodes] == [n["restPositionMeters"] for n in original]
    assert [n["id"] for n in nodes] == [n["id"] for n in original]
    assert nodes[1]["explodeDirection"] != nodes[2]["explodeDirection"]
    assert all(n["explodeDistanceMeters"] > 0 for n in nodes[1:])
    expected = copy.deepcopy(nodes)
    assign_inspection_offsets(nodes)
    assert nodes == expected
