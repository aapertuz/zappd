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
  assert.equal(catalog.semantics, 'source_inspection');
  assert.equal(catalog.nodes.length, 289);
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
  const rejected = catalog.nodes.filter(
    (node) => node.specifications.geometryStatus === 'unavailable',
  );
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].name, 'head_face');
  assert.equal(rejected[0].stepFixtureName, null);
  assert.equal(rejected[0].geometry.kind, 'unavailable');
});

it('catalogs Poppy boards, routed cables, and separate Dynamixel buses', () => {
  const { nodes, relationships } = getCatalogArchetypeById('poppy_humanoid_v1');
  const boards = nodes.filter(({ origin }) => origin === 'kicad_pcb_step');
  const cables = nodes.filter(({ origin }) => origin === 'procedural_harness');
  const portNodes = nodes.filter(({ ports }) => ports?.length > 0);
  assert.deepEqual(
    new Set(boards.map(({ id }) => id)),
    new Set(['comp_poppy_usb2ax_upper', 'comp_poppy_usb2ax_lower', 'comp_poppy_upper_3p_hub']),
  );
  assert.equal(cables.length, 33);
  assert.equal(portNodes.length, 34);
  assert.equal(portNodes.filter(({ origin }) => origin === 'open_step_catalog').length, 31);
  assert.ok(boards.every((board) => portNodes.includes(board)));

  const electrical = relationships.filter(
    ({ connectionType }) => connectionType === 'electrical_bus' || connectionType === 'power_bus',
  );
  assert.equal(relationships.length, 69);
  assert.equal(electrical.length, 33);
  assert.equal(
    relationships.filter(({ connectionType }) => connectionType === 'assembly_mount').length,
    36,
  );

  const nodesById = new Map(portNodes.map((node) => [node.id, node]));
  const dynamixelLinks = electrical.filter(({ fromComponentId, fromPortId }) =>
    nodesById
      .get(fromComponentId)
      ?.ports.some(
        ({ portId, busKind }) =>
          portId === fromPortId && (busKind === 'ttl_serial' || busKind === 'dc_power'),
      ),
  );
  assert.equal(dynamixelLinks.length, 29);
  const controllers = new Set();
  for (const { fromComponentId, toComponentId } of dynamixelLinks) {
    const from = nodesById.get(fromComponentId).specifications.controller;
    const to = nodesById.get(toComponentId).specifications.controller;
    assert.equal(from, to);
    controllers.add(from);
  }
  assert.deepEqual(controllers, new Set(['upper_body_controller', 'lower_body_controller']));
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

it('limits unverified inspection to source inspection archetypes with complete provenance and reports', () => {
  const checksum = 'a'.repeat(64);
  const catalog = getCatalogArchetypeById('poppy_humanoid_v1');
  const nodes = catalog.nodes.map((node) => ({
    ...node,
    provenance: {
      origin: node.origin,
      verificationStatus: 'unverified',
      spdxLicense: node.spdxLicense,
      sourceUrl: node.sourceUrl,
      sourceName: node.sourceName,
      stepSha256: node.expectedStepSha256 ?? checksum,
    },
    glbNodeName: node.id,
    usdzPrimPath: `/World/${node.id}`,
  }));
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
    archetypeId: catalog.archetypeId,
    verificationStatus: 'unverified',
    nodes,
    validation: completeValidation,
  };
  assert.equal(canInspectSourceAssembly(poppyAssembly), true);
  assert.equal(isAllowedProjectAssembly(poppyAssembly), true);
  assert.equal(
    isAllowedProjectAssembly({ ...poppyAssembly, archetypeId: 'quadcopter_drone_v1' }),
    false,
  );
  for (const report of ['sourceInterferenceReport', 'engineeringReport']) {
    const withoutReport = {
      ...poppyAssembly,
      validation: { ...completeValidation, [report]: undefined },
    };
    assert.equal(canInspectSourceAssembly(withoutReport), false, report);
    assert.equal(isAllowedProjectAssembly(withoutReport), false, report);
  }

  const cases = [
    ['open_step_catalog', 'wrong STEP URI scheme', { sourceUrl: 'kicad://poppy/source' }],
    ['kicad_pcb_step', 'wrong board URI scheme', { sourceUrl: 'harness://poppy/board' }],
    ['procedural_harness', 'insecure harness URI', { sourceUrl: 'http://example.test/poppy' }],
    ['kicad_pcb_step', 'unknown origin', { origin: 'unknown' }],
    ['kicad_pcb_step', 'verified node status', { verificationStatus: 'composed_validated' }],
    ['kicad_pcb_step', 'blank license', { spdxLicense: ' ' }],
    ['procedural_harness', 'invalid STEP digest', { stepSha256: 'invalid' }],
  ];
  for (const [origin, label, overrides] of cases) {
    const index = nodes.findIndex((node) => node.origin === origin);
    const node = nodes[index];
    const altered = {
      ...poppyAssembly,
      nodes: nodes.with(index, { ...node, provenance: { ...node.provenance, ...overrides } }),
    };
    assert.equal(canInspectSourceAssembly(altered), false, label);
    assert.equal(isAllowedProjectAssembly(altered), false, label);
  }

  const index = nodes.findIndex((node) => node.origin === 'open_step_catalog');
  const { sourceSha256, ...specifications } = nodes[index].specifications;
  assert.ok(sourceSha256);
  const withoutSourceDigest = {
    ...poppyAssembly,
    nodes: nodes.with(index, { ...nodes[index], specifications }),
  };
  assert.equal(canInspectSourceAssembly(withoutSourceDigest), false);
  assert.equal(isAllowedProjectAssembly(withoutSourceDigest), false);
});
