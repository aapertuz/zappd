import assert from 'node:assert/strict';
import { it } from 'node:test';

import { canInspectSourceAssembly, verifyOneToOneNodeMapping } from '../assembly.ts';
import {
  getCatalogArchetypeById,
  isAllowedProjectAssembly,
  matchProjectArchetypeFromPrompt,
} from '../catalog.ts';

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
  assert.equal(verifyOneToOneNodeMapping(nodes, ['available'], ['/available']), false);
  assert.equal(
    verifyOneToOneNodeMapping(nodes, ['available'], ['/available'], {
      allowUnavailableNodes: true,
    }),
    true,
  );
  assert.equal(verifyOneToOneNodeMapping(nodes, [], [], { allowUnavailableNodes: true }), false);
  assert.equal(
    canInspectSourceAssembly({
      nodes: [],
      verificationStatus: 'unverified',
      validation: { brepValid: true, nodeMappingComplete: true },
    }),
    false,
  );
});

it('limits the unverified source inspection exception to source_inspection archetypes with reports', () => {
  const checksum = 'a'.repeat(64);
  const sampleNode = {
    id: 'poppy_1_1_1',
    parentId: null,
    name: 'pelvis',
    level: 'component',
    depth: 1,
    category: 'cad_part',
    colorHex: '#cbd5e1',
    dimensionsMm: [10, 10, 10],
    restPositionMeters: [0, 0, 0],
    explodeDirection: [0, 1, 0],
    explodeDistanceMeters: 0.05,
    materialHint: 'unspecified',
    geometry: { kind: 'available', role: 'solid' },
    specifications: { sourceSha256: checksum },
    provenance: {
      origin: 'open_step_catalog',
      verificationStatus: 'unverified',
      spdxLicense: 'CC-BY-SA-4.0',
      sourceUrl:
        'https://github.com/poppy-project/poppy-humanoid/releases/download/1.0.2/Poppy_Humanoid.STEP',
      sourceName: 'Poppy',
      stepSha256: checksum,
    },
    glbNodeName: 'poppy_1_1_1',
    usdzPrimPath: '/poppy_1_1_1',
  };
  const completeValidation = {
    valid: false,
    brepValid: true,
    interferenceCount: 1,
    maxDimensionalErrorMm: 0.05,
    nodeMappingComplete: true,
    unitSystem: 'meters_y_up',
    checkedAtIso: '2026-11-25T00:00:00.000Z',
    failures: ['Partial source inspection'],
    sourceInterferenceReport: {
      status: 'partial',
      solidCount: 1,
      possiblePairCount: 0,
      candidatePairCount: 0,
      intersectionCount: 0,
      unresolvedPairCount: 0,
      volumeThresholdMm3: 0.001,
      aabbToleranceMm: 1e-7,
      excludedComponents: [],
      pairs: [],
      limitations: [],
    },
    engineeringReport: {
      status: 'unverified',
      manufacturingReadiness: 'not_established',
      materials: 'unknown',
      manufacturingTolerances: 'unknown',
      loadsAndConstraints: 'not_verified',
      renderDimensionComparison: {
        maximumErrorMm: 0.05,
        thresholdMm: 0.1,
        meaning: 'CAD to render bounds comparison',
      },
      nodeMappingComplete: true,
      rejectedCadComponentIds: [],
      surfaceComponentIds: [],
    },
  };
  const poppyAssembly = {
    archetypeId: 'poppy_humanoid_v1',
    verificationStatus: 'unverified',
    nodes: [sampleNode],
    validation: completeValidation,
  };
  assert.equal(isAllowedProjectAssembly(poppyAssembly), true);
  assert.equal(
    isAllowedProjectAssembly({ ...poppyAssembly, archetypeId: 'quadcopter_drone_v1' }),
    false,
  );
  assert.equal(
    isAllowedProjectAssembly({
      ...poppyAssembly,
      validation: { ...completeValidation, sourceInterferenceReport: undefined },
    }),
    false,
  );
  assert.equal(
    isAllowedProjectAssembly({
      ...poppyAssembly,
      validation: { ...completeValidation, engineeringReport: undefined },
    }),
    false,
  );
});
