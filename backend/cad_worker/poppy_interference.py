from __future__ import annotations

import argparse
import hashlib
import json
import math
import multiprocessing
from pathlib import Path
from queue import Empty
from typing import Literal, TypedDict

from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
from OCP.BRepGProp import BRepGProp
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.GProp import GProp_GProps
from OCP.TopAbs import TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer

from catalog_ingestor import resolve_component_step
from geometry_pipeline import shape_bounds_mm, translate_shape_mm, world_rest_to_cad_mm


class PairResult(TypedDict):
    componentIds: list[str]
    status: Literal['intersection', 'contact_or_below_threshold', 'failed', 'timeout']
    volumeMm3: float | None
    error: str | None


def exact_pair(shape_a, shape_b, ids: list[str], threshold: float) -> PairResult:
    result: PairResult = dict(componentIds=ids, status='failed', volumeMm3=None, error=None)
    try:
        operation = BRepAlgoAPI_Common(shape_a, shape_b)
        if not operation.IsDone():
            raise RuntimeError('OCCT common did not complete')
        common = operation.Shape()
        if common.IsNull() or not BRepCheck_Analyzer(common).IsValid():
            raise RuntimeError('OCCT common returned invalid topology')
        properties = GProp_GProps()
        BRepGProp.VolumeProperties_s(common, properties)
        volume = float(properties.Mass())
        if not math.isfinite(volume) or volume < 0:
            raise RuntimeError('OCCT common returned invalid volume')
        result['volumeMm3'] = volume
        result['status'] = 'intersection' if volume > threshold else 'contact_or_below_threshold'
    except Exception as error:
        result['error'] = str(error)
    return result


def _shape_worker(queue, first, second, ids, threshold):
    queue.put(exact_pair(first, second, ids, threshold))


def _worker(queue, nodes, cache: Path, threshold: float):
    shapes = [translate_shape_mm(resolve_component_step(node, cache)['shape'],
                                world_rest_to_cad_mm(node['restPositionMeters'])) for node in nodes]
    queue.put(exact_pair(*shapes, [node['id'] for node in nodes], threshold))


def analyze(spec: dict, cache: Path, timeout_seconds: float = 30, threshold_mm3: float = 0.001) -> dict:
    if timeout_seconds <= 0 or threshold_mm3 < 0:
        raise ValueError('Timeout must be positive and volume threshold nonnegative')
    nodes = []
    bounds = {}
    placed_shapes = {}
    provenance = []
    exclusions = []
    for node in spec['nodes']:
        geometry = node['geometry']
        if geometry['kind'] == 'assembly':
            continue
        if geometry['kind'] != 'available' or geometry.get('role') == 'surface':
            exclusions.append(dict(componentId=node['id'], reason=geometry))
            continue
        resolved = resolve_component_step(node, cache)
        provenance.append(dict(componentId=node['id'], fixture=node['stepFixtureName'], sha256=resolved['sha256'], restPositionMeters=node['restPositionMeters']))
        shape = resolved['shape']
        if not TopExp_Explorer(shape, TopAbs_SOLID).More():
            raise ValueError(f"Component {node['id']} declared solid has no CAD solid")
        placed = translate_shape_mm(shape, world_rest_to_cad_mm(node['restPositionMeters']))
        placed_shapes[node['id']] = placed
        bounds[node['id']] = shape_bounds_mm(placed)
        nodes.append(node)
    candidates = []
    for index, first in enumerate(nodes):
        low_a, high_a = bounds[first['id']]
        for second in nodes[index + 1:]:
            low_b, high_b = bounds[second['id']]
            if all(low_a[axis] <= high_b[axis] + 1e-7 and low_b[axis] <= high_a[axis] + 1e-7 for axis in range(3)):
                candidates.append((first, second))
    context = multiprocessing.get_context('fork' if 'fork' in multiprocessing.get_all_start_methods() else 'spawn')
    results = []
    for first, second in candidates:
        queue = context.Queue()
        if context.get_start_method() == 'fork':
            process = context.Process(target=_shape_worker, args=(queue, placed_shapes[first['id']], placed_shapes[second['id']], [first['id'], second['id']], threshold_mm3))
        else:
            process = context.Process(target=_worker, args=(queue, (first, second), cache, threshold_mm3))
        process.start()
        try:
            result = queue.get(timeout=timeout_seconds)
        except Empty:
            result = dict(componentIds=[first['id'], second['id']], status='timeout' if process.is_alive() else 'failed', volumeMm3=None, error='Pair worker produced no result within deadline')
        finally:
            if process.is_alive():
                process.terminate()
            process.join()
            queue.close()
        results.append(result)
    return dict(status='partial', method='source placement AABB then OCCT common',
                solidCount=len(nodes), excludedComponents=exclusions, sourceComponents=provenance,
                possiblePairCount=len(nodes)*(len(nodes)-1)//2,
                candidatePairCount=len(candidates), volumeThresholdMm3=threshold_mm3,
                aabbToleranceMm=1e-7, timeoutSecondsPerPair=timeout_seconds,
                pairs=results, intersectionCount=sum(p['status']=='intersection' for p in results),
                unresolvedPairCount=sum(p['status'] in ('failed', 'timeout') for p in results),
                limitations=['Excluded CAD is not clear of interference', 'Contacts below threshold do not establish intended fits', 'Materials, manufacturing tolerances, loads and assembly constraints are not verified'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('catalog', type=Path)
    parser.add_argument('cache', type=Path)
    parser.add_argument('output', type=Path)
    arguments = parser.parse_args()
    payload = arguments.catalog.read_bytes()
    report = analyze(json.loads(payload), arguments.cache)
    report['catalogSha256'] = hashlib.sha256(payload).hexdigest()
    arguments.output.write_text(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
