import assert from 'node:assert/strict';
import { it } from 'node:test';

import { computeNodeWorldPositionMeters, verifyOneToOneNodeMapping } from '../assembly.ts';

it('maps visual-only head by stable identity while keeping its CAD rejection', () => {
  const head = {
    id: 'poppy_1_28_5',
    level: 'component',
    depth: 2,
    parentId: null,
    geometry: { kind: 'visual_only', cadRejectionReason: 'Invalid source BRep' },
    glbNodeName: 'poppy_1_28_5',
    usdzPrimPath: '/poppy_1_28_5',
    restPositionMeters: [0, 0.33642830040470106, 0.022285019608571526],
    explodeDirection: [0, 0, 1],
    explodeDistanceMeters: 0.066585,
  };
  assert.equal(verifyOneToOneNodeMapping([head], [head.id], [head.usdzPrimPath]), true);
  assert.equal(verifyOneToOneNodeMapping([head], [], []), false);
  const byId = { [head.id]: head };
  const rest = computeNodeWorldPositionMeters(head, byId, 0, {});
  const exploded = computeNodeWorldPositionMeters(head, byId, 1, {});
  assert.deepEqual(rest, head.restPositionMeters);
  assert.equal(exploded[0], rest[0]);
  assert.equal(exploded[1], rest[1]);
  assert.ok(Math.abs(exploded[2] - rest[2] - head.explodeDistanceMeters) < 1e-12);
  assert.deepEqual(computeNodeWorldPositionMeters(head, byId, 0, {}), rest);
  assert.equal(head.geometry.cadRejectionReason, 'Invalid source BRep');
});
