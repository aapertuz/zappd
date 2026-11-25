from __future__ import annotations

from dataclasses import dataclass
from heapq import heappop, heappush
from itertools import product
from math import ceil, dist, floor, inf

import numpy as np
from OCP.Bnd import Bnd_OBB
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeVertex
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.gp import gp_Pnt
from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS_Shape


@dataclass(frozen=True)
class RoutingBox:
    half_size: np.ndarray
    center: np.ndarray
    axes: np.ndarray
    component_id: str
    precise_shape: TopoDS_Shape | None

    @classmethod
    def from_shape(cls, shape: TopoDS_Shape, component_id: str, precise: bool = False) -> RoutingBox:
        box = Bnd_OBB()
        BRepBndLib.AddOBB_s(shape, box, True, True, False)
        xyz = lambda point: (point.X(), point.Y(), point.Z())
        return cls(
            np.array([box.XHSize(), box.YHSize(), box.ZHSize()]),
            np.array(xyz(box.Center())),
            np.array([xyz(axis) for axis in (box.XDirection(), box.YDirection(), box.ZDirection())]),
            component_id, shape if precise else None,
        )


def routing_boxes(
    solids: dict[str, TopoDS_Shape], endpoints: set[str], harnesses: set[str] | None = None,
) -> list[RoutingBox]:
    boxes = []
    for cid, shape in solids.items():
        if cid in (harnesses or set()):
            explorer = TopExp_Explorer(shape, TopAbs_FACE)
            while explorer.More():
                boxes.append(RoutingBox.from_shape(explorer.Current(), cid))
                explorer.Next()
        elif cid in endpoints:
            explorer = TopExp_Explorer(shape, TopAbs_SOLID)
            while explorer.More():
                boxes.append(RoutingBox.from_shape(explorer.Current(), cid, precise=True))
                explorer.Next()
        else:
            boxes.append(RoutingBox.from_shape(shape, cid))
    return boxes


class RoutingSpace:
    def __init__(self, boxes: list[RoutingBox], clearance: float):
        self.boxes = boxes
        self.clearance = clearance
        self.axes = np.array([box.axes for box in boxes])
        self.centers = np.array([box.center for box in boxes])
        self.half_sizes = np.array([box.half_size for box in boxes]) + clearance
        self.world_half_sizes = (
            np.einsum("nij,ni->nj", abs(self.axes), self.half_sizes) if boxes else np.empty((0, 3))
        )

    def clear(
        self, start: np.ndarray, end: np.ndarray, collar_owner: str | None = None, *, precise: bool = True,
    ) -> bool:
        if not self.boxes:
            return True
        low = np.minimum(start, end)
        high = np.maximum(start, end)
        nearby = np.all((low <= self.centers + self.world_half_sizes) &
                        (high >= self.centers - self.world_half_sizes), axis=1)
        indices = np.flatnonzero(nearby)
        for index in indices:
            box = self.boxes[index]
            p = box.axes @ (start - box.center)
            q = box.axes @ (end - box.center)
            half = self.half_sizes[index]
            if collar_owner == box.component_id and np.all(abs(p) <= half):
                continue
            near, far = 0.0, 1.0
            for a, b, size in zip(p, q, half):
                delta = b - a
                if abs(delta) < 1e-9:
                    if abs(a) > size:
                        break
                    continue
                enter, leave = sorted(((-size - a) / delta, (size - a) / delta))
                near, far = max(near, enter), min(far, leave)
                if near > far:
                    break
            else:
                if box.precise_shape is None or not precise:
                    return False
                if dist(start, end) < 1e-7:
                    probe = BRepBuilderAPI_MakeVertex(gp_Pnt(*start)).Vertex()
                else:
                    probe = BRepBuilderAPI_MakeEdge(gp_Pnt(*start), gp_Pnt(*end)).Edge()
                distance = BRepExtrema_DistShapeShape(probe, box.precise_shape)
                if not distance.IsDone() or distance.Value() <= self.clearance:
                    return False
        return True


def escape_port(
    space: RoutingSpace, position: np.ndarray, direction: np.ndarray, owner: str, initial_gap: float,
) -> tuple[np.ndarray, np.ndarray] | None:
    for gap in (initial_gap, max(initial_gap, 1.4), max(initial_gap, 2.0), max(initial_gap, 3.0)):
        start = position + direction * gap
        for lead in (4.5, 3.0, 1.8, 0.9):
            if gap + lead > 6:
                continue
            stub = start + direction * lead
            if not space.clear(position, stub, owner):
                continue
            if space.clear(stub, stub):
                return start, stub
    return None


def channel_paths(space: RoutingSpace, start: np.ndarray, end: np.ndarray):
    yield [start, end]
    candidates = []
    for axis in (2, 1, 0):
        heights = {
            coordinate + sign * offset
            for sign, coordinate in ((1, max(start[axis], end[axis])), (-1, min(start[axis], end[axis])))
            for offset in (5, 12, 24)
        }
        heights.update((start[axis], end[axis]))
        for center, half in zip(space.centers, space.world_half_sizes):
            if np.any(abs(center - (start + end) / 2) > half + abs(start - end) / 2 + 28):
                continue
            heights.update((center[axis] - half[axis] - 3, center[axis] + half[axis] + 3))
        for height in heights:
            first, second = start.copy(), end.copy()
            first[axis] = second[axis] = height
            path = [start, first, second, end]
            length = sum(dist(before, after) for before, after in zip(path, path[1:]))
            candidates.append((length, axis, height, path))
    for _, _, _, path in sorted(candidates):
        yield path


def _simplify(space: RoutingSpace, path: list[np.ndarray]) -> list[np.ndarray]:
    selected = [path[0]]
    cursor = 0
    while cursor < len(path) - 1:
        cursor = next(index for index in range(len(path) - 1, cursor, -1)
                      if space.clear(selected[-1], path[index]))
        selected.append(path[cursor])
    return selected


_GRID_STEPS = sorted(
    (dist((0, 0, 0), step), step)
    for step in product((-1, 0, 1), repeat=3) if step != (0, 0, 0)
)


def voxel_path(space: RoutingSpace, start: np.ndarray, end: np.ndarray, cell_mm: float) -> list[np.ndarray] | None:
    margin = 32.0
    lower = np.minimum(start, end) - margin
    upper = np.maximum(start, end) + margin
    limits = tuple(floor(axis) for axis in (upper - lower) / cell_mm)
    steps = [(length * cell_mm, delta) for length, delta in _GRID_STEPS]
    heuristic_weight = 1.6

    def point(index: tuple[int, int, int]) -> np.ndarray:
        return lower + cell_mm * np.asarray(index)

    base = (start - lower) / cell_mm
    entry_cells = product(*(range(floor(axis) - 1, ceil(axis) + 2) for axis in base))
    parents = {}
    best_cost = {}
    queue = []
    for entry in entry_cells:
        xyz = point(entry)
        if space.clear(start, xyz):
            cost = dist(start, xyz)
            best_cost[entry] = cost
            parents[entry] = None
            heappush(queue, (cost + heuristic_weight * dist(xyz, end), cost, entry))

    visited = 0
    while queue and visited < 10_000:
        _, cost, index = heappop(queue)
        if best_cost[index] != cost:
            continue
        visited += 1
        xyz = point(index)
        remaining = dist(xyz, end)
        if remaining <= 3 * cell_mm and space.clear(xyz, end):
            path = [end]
            while index is not None:
                path.append(point(index))
                index = parents[index]
            return _simplify(space, [start, *reversed(path)])
        for weight, delta in steps:
            neighbor = tuple(a + b for a, b in zip(index, delta))
            if any(value < 0 or value > limit for value, limit in zip(neighbor, limits)):
                continue
            length = cost + weight
            if length >= best_cost.get(neighbor, inf) - 1e-9:
                continue
            middle = point(neighbor)
            if space.clear(xyz, middle, precise=False):
                parents[neighbor] = index
                best_cost[neighbor] = length
                heappush(queue, (length + heuristic_weight * dist(middle, end), length, neighbor))
    return None
