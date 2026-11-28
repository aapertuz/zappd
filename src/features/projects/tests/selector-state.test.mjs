import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

import { CATALOG_ARCHETYPES } from '@/shared/domain';

import {
  buildAssemblyRouteHref,
  buildCatalogAssemblyCards,
  createInitialSelectorState,
  reduceSelectorState,
  resolveRequestedArchetypeId,
} from '../model/selectorState.ts';

it('builds an ordered card for each catalog assembly with separate commercial and technical names', () => {
  const cards = buildCatalogAssemblyCards();
  assert.deepEqual(
    cards.map(({ archetypeId }) => archetypeId),
    CATALOG_ARCHETYPES.map(({ archetypeId }) => archetypeId),
  );
  assert.deepEqual(cards[0], {
    archetypeId: 'quadcopter_drone_v1',
    commercialName: 'Aero X4',
    technicalTitle: 'Quadcopter Drone CAD Assembly',
    partCount: 42,
    category: 'Flight',
    badge: 'verified',
  });
  assert.equal(
    cards.find(({ archetypeId }) => archetypeId === 'poppy_humanoid_v1').badge,
    'source_inspection',
  );
  assert.equal(
    cards.find(({ archetypeId }) => archetypeId === 'dual_scorpion_v1').badge,
    'source_inspection',
  );
  assert.equal(
    cards.find(({ archetypeId }) => archetypeId === 'parametric_multirotor_v1').badge,
    'parametric',
  );
  for (const { archetypeId, partCount } of cards) {
    const spec = CATALOG_ARCHETYPES.find((entry) => entry.archetypeId === archetypeId);
    assert.equal(partCount, spec.nodes.length);
    const png = readFileSync(
      new URL(`../../../../assets/images/assembly-previews/${archetypeId}.png`, import.meta.url),
    );
    assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.equal(png.readUInt32BE(16), 640);
    assert.equal(png.readUInt32BE(20), 400);
    assert.equal(png[25], 6);
  }
});

it('starts the turntable on Aero X4 and tracks activation, visibility, and reduced motion', () => {
  const initial = createInitialSelectorState();
  assert.equal(initial.activeTurntableArchetypeId, 'quadcopter_drone_v1');

  const active = reduceSelectorState(initial, {
    type: 'activateTurntable',
    archetypeId: 'reachy_mini_v1',
  });
  assert.equal(active.activeTurntableArchetypeId, 'reachy_mini_v1');
  assert.equal(
    reduceSelectorState(active, { type: 'activateTurntable', archetypeId: 'reachy_mini_v1' }),
    active,
  );

  const visible = reduceSelectorState(active, {
    type: 'setVisibility',
    changes: new Map([
      ['quadcopter_drone_v1', true],
      ['reachy_mini_v1', true],
    ]),
  });
  assert.deepEqual(visible.visibleCardIds, ['quadcopter_drone_v1', 'reachy_mini_v1']);
  const scrolled = reduceSelectorState(visible, {
    type: 'setVisibility',
    changes: new Map([['quadcopter_drone_v1', false]]),
  });
  assert.deepEqual(scrolled.visibleCardIds, ['reachy_mini_v1']);
  assert.equal(
    reduceSelectorState(scrolled, { type: 'setReducedMotion', reducedMotion: true }).reducedMotion,
    true,
  );
});

it('builds a direct route for every catalog ID and rejects unknown route parameters', () => {
  for (const { archetypeId } of CATALOG_ARCHETYPES) {
    assert.equal(buildAssemblyRouteHref(archetypeId), `/assemblies/${archetypeId}`);
    assert.equal(resolveRequestedArchetypeId(archetypeId), archetypeId);
  }
  assert.equal(resolveRequestedArchetypeId('invalid'), undefined);
  assert.equal(resolveRequestedArchetypeId(undefined), undefined);
});
