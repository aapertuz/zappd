import assert from 'node:assert/strict';
import { it } from 'node:test';

import { canInspectSourceAssembly, verifyOneToOneNodeMapping } from '../assembly.ts';
import { getCatalogArchetypeById, matchProjectArchetypeFromPrompt } from '../catalog.ts';

it('matches Poppy and preserves hierarchy without invented instructions', () => {
  const catalog = getCatalogArchetypeById('poppy_humanoid_v1');
  assert.equal(
    matchProjectArchetypeFromPrompt('inspect Poppy humanoid').archetypeId,
    catalog.archetypeId,
  );
  assert.equal(catalog.nodes.length, new Set(catalog.nodes.map((node) => node.id)).size);
  assert.equal(catalog.nodes.filter((node) => node.parentId === null).length, 1);
  const ids = new Set(catalog.nodes.map((node) => node.id));
  assert.ok(catalog.nodes.every((node) => node.parentId === null || ids.has(node.parentId)));
  assert.ok(
    catalog.nodes
      .filter((node) => node.parentId !== null)
      .every((node) => node.explodeDistanceMeters > 0),
  );
  assert.deepEqual(catalog.assemblySteps, []);
  assert.deepEqual(catalog.relationships, []);
  const rejected = catalog.nodes.filter(
    (node) => node.specifications.geometryStatus === 'unavailable',
  );
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].name, 'head_face');
  assert.equal(rejected[0].stepFixtureName, null);
});

it('maps available components while retaining rejected component identities', () => {
  const nodes = [
    {
      id: 'available',
      level: 'component',
      geometry: { kind: 'available', role: 'surface' },
      glbNodeName: 'available',
      usdzPrimPath: '/available',
    },
    {
      id: 'head',
      level: 'component',
      geometry: { kind: 'unavailable', reason: 'invalid source' },
      glbNodeName: 'head',
      usdzPrimPath: '/head',
    },
  ];
  assert.equal(verifyOneToOneNodeMapping(nodes, ['available'], ['/available']), true);
  assert.equal(verifyOneToOneNodeMapping(nodes, [], []), false);
  assert.equal(
    canInspectSourceAssembly({
      nodes: [],
      verificationStatus: 'unverified',
      validation: { brepValid: true, nodeMappingComplete: true },
    }),
    false,
  );
});
