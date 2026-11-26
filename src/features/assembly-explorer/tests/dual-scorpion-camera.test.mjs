import assert from 'node:assert/strict';
import { it } from 'node:test';

import { getCatalogArchetypeById } from '@/shared/domain';

import { computeDefaultCameraForAssembly } from '../model/explorerState.ts';

it('frames the full Dual Scorpion source assembly on initial load', () => {
  const catalog = getCatalogArchetypeById('dual_scorpion_v1');
  const root = catalog.nodes.find((node) => node.id === catalog.rootNodeId);
  assert.ok(root);
  const camera = computeDefaultCameraForAssembly({ archetypeId: catalog.archetypeId });
  const verticalSpanMeters = 2 * camera.distanceMeters * Math.tan(Math.PI / 8);
  assert.ok(verticalSpanMeters > Math.max(...root.dimensionsMm) / 1000);
});
