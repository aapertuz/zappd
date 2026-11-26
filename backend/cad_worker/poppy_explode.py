import hashlib
import math


def assign_inspection_offsets(nodes: list[dict]) -> None:
    by_id = {node["id"]: node for node in nodes}
    children = {node["id"]: [] for node in nodes}
    for node in nodes:
        if node["parentId"] is not None:
            children[node["parentId"]].append(node)
    centers = {}

    def center(node):
        if node["id"] in centers:
            return centers[node["id"]]
        descendants = children[node["id"]]
        if descendants:
            points = [center(child) for child in descendants]
            result = [sum(point[axis] for point in points) / len(points) for axis in range(3)]
        else:
            result = node["restPositionMeters"]
        centers[node["id"]] = result
        return result

    for node in nodes:
        parent_id = node["parentId"]
        if parent_id is None:
            continue
        origin = center(by_id[parent_id])
        delta = [value - base for value, base in zip(center(node), origin)]
        length = math.hypot(*delta)
        if length < 1e-6:
            digest = hashlib.sha256(node["id"].encode()).digest()
            delta = [int.from_bytes(digest[axis * 2:axis * 2 + 2], "big") / 32767.5 - 1 for axis in range(3)]
            length = math.hypot(*delta)
        node["explodeDirection"] = [value / length for value in delta]
        node["explodeDistanceMeters"] = max(0.025, min(0.12, max(node["dimensionsMm"]) / 2000))
