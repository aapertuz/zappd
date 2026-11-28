import assert from 'node:assert/strict';
import { it } from 'node:test';

import { getCatalogArchetypeById, matchProjectArchetypeFromPrompt } from '../catalog.ts';

it('matches Dual Scorpion inspection with pinned source parts and URDF link hierarchy', () => {
  const catalog = getCatalogArchetypeById('dual_scorpion_v1');
  assert.equal(
    matchProjectArchetypeFromPrompt('inspect Dual Scorpion').archetypeId,
    catalog.archetypeId,
  );
  assert.equal(catalog.nodes.filter((node) => node.parentId === null).length, 1);
  assert.equal(catalog.nodes.filter((node) => node.category === 'cad_part').length, 70);

  const ids = new Set(catalog.nodes.map((node) => node.id));
  assert.equal(ids.size, catalog.nodes.length);
  assert.ok(catalog.nodes.every((node) => node.parentId === null || ids.has(node.parentId)));
  assert.ok(
    catalog.nodes
      .filter((node) => node.parentId !== null)
      .every((node) => node.explodeDistanceMeters > 0),
  );
  assert.deepEqual(catalog.assemblySteps, []);
  assert.deepEqual(catalog.relationships, []);

  const parts = catalog.nodes.filter((node) => node.category === 'cad_part');
  assert.equal(
    parts.filter((node) => node.specifications.geometryStatus === 'available').length,
    57,
  );
  assert.equal(
    parts.filter((node) => node.specifications.geometryStatus === 'unavailable').length,
    13,
  );
  assert.ok(
    parts.every((node) => {
      const sourceSha256 = node.specifications.sourceSha256;
      const linkName = node.specifications.urdfLinkName;
      return (
        typeof sourceSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(sourceSha256) &&
        node.sourceUrl.startsWith(
          'https://raw.githubusercontent.com/momoiorg-repository/dual_scorpion/cc5b46ca9611ea5568b017bc5bff9f01945d25a3/',
        ) &&
        node.parentId === `dual_scorpion_${linkName}`
      );
    }),
  );

  const base = parts.find((node) => node.id === 'dual_scorpion_part_base');
  assert.ok(base);
  assert.deepEqual(base.restPositionMeters, [-0.000646, 0.010686, 0.001696]);
});
