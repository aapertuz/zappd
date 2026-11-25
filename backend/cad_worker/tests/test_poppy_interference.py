import sys
from pathlib import Path

import pytest
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.gp import gp_Pnt

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import poppy_interference


@pytest.mark.parametrize('offset, status, volume', [(0.5, 'intersection', 0.5), (1, 'contact_or_below_threshold', 0), (2, 'contact_or_below_threshold', 0)])
def test_exact_overlap_contact_and_separation(offset, status, volume):
    first = BRepPrimAPI_MakeBox(1, 1, 1).Shape()
    second = BRepPrimAPI_MakeBox(gp_Pnt(offset, 0, 0), 1, 1, 1).Shape()
    result = poppy_interference.exact_pair(first, second, ['a', 'b'], 0.001)
    assert result['status'] == status
    assert result['volumeMm3'] == pytest.approx(volume)
    assert result['componentIds'] == ['a', 'b']


def test_failed_boolean_is_never_clear(monkeypatch):
    class FailedCommon:
        def __init__(self, *args):
            pass

        def IsDone(self):
            return False

    monkeypatch.setattr(poppy_interference, 'BRepAlgoAPI_Common', FailedCommon)
    result = poppy_interference.exact_pair(None, None, ['a', 'b'], 0.001)
    assert result['status'] == 'failed'
    assert result['volumeMm3'] is None
    assert result['error']


def test_broad_phase_keeps_surface_and_rejected_cad_exclusions_explicit(monkeypatch, tmp_path):
    shape = BRepPrimAPI_MakeBox(1, 1, 1).Shape()
    monkeypatch.setattr(poppy_interference, 'resolve_component_step', lambda node, cache: dict(shape=shape, sha256='fixture-digest'))
    nodes = [dict(id='root', geometry=dict(kind='assembly'))]
    for identifier, offset in [('a', 0), ('b', 10)]:
        nodes.append(dict(id=identifier, geometry=dict(kind='available', role='solid'), stepFixtureName=f'{identifier}.step', restPositionMeters=[offset, 0, 0]))
    nodes.extend([dict(id='surface', geometry=dict(kind='available', role='surface')), dict(id='head', geometry=dict(kind='unavailable', reason='invalid topology'))])
    report = poppy_interference.analyze(dict(nodes=nodes), tmp_path)
    assert report['solidCount'] == 2
    assert report['possiblePairCount'] == 1
    assert report['candidatePairCount'] == 0
    assert report['pairs'] == []
    assert report['status'] == 'partial'
    assert [item['componentId'] for item in report['excludedComponents']] == ['surface', 'head']
    assert [item['componentId'] for item in report['sourceComponents']] == ['a', 'b']


def test_pair_deadline_is_unresolved_not_clear(monkeypatch, tmp_path):
    shape = BRepPrimAPI_MakeBox(1, 1, 1).Shape()
    monkeypatch.setattr(poppy_interference, 'resolve_component_step', lambda node, cache: dict(shape=shape, sha256='fixture-digest'))
    nodes = [dict(id=identifier, geometry=dict(kind='available', role='solid'), stepFixtureName=f'{identifier}.step', restPositionMeters=[0, 0, 0]) for identifier in ['a', 'b']]
    report = poppy_interference.analyze(dict(nodes=nodes), tmp_path, timeout_seconds=0.001)
    assert report['candidatePairCount'] == 1
    assert report['unresolvedPairCount'] == 1
    assert report['intersectionCount'] == 0
    assert report['pairs'][0]['status'] == 'timeout'
    assert report['pairs'][0]['volumeMm3'] is None
