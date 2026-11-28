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
  assert.equal(catalog.nodes.length, 303);
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
    new Set([
      'comp_poppy_usb2ax_upper',
      'comp_poppy_usb2ax_lower',
      'comp_poppy_upper_3p_hub',
      'comp_poppy_power_dist',
      'comp_poppy_5v_buck',
      'comp_poppy_audio_amp',
    ]),
  );
  assert.equal(cables.length, 43);
  assert.equal(portNodes.length, 41);
  assert.equal(portNodes.filter(({ origin }) => origin === 'open_step_catalog').length, 34);
  assert.ok(boards.every((board) => portNodes.includes(board)));

  const electrical = relationships.filter(
    ({ connectionType }) => connectionType === 'electrical_bus' || connectionType === 'power_bus',
  );
  assert.equal(relationships.length, 93);
  assert.equal(electrical.length, 43);
  assert.equal(
    relationships.filter(({ connectionType }) => connectionType === 'assembly_mount').length,
    50,
  );

  const nodesById = new Map(portNodes.map((node) => [node.id, node]));
  const dynamixelLinks = electrical.filter(({ fromComponentId, fromPortId }) =>
    nodesById
      .get(fromComponentId)
      ?.ports.some(
        ({ portId, busKind }) =>
          portId === fromPortId && (busKind === 'ttl_serial' || portId === 'port_dxl_power'),
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

it('routes battery and 5 V power and connects each head peripheral to its assigned port', () => {
  const { nodes, relationships } = getCatalogArchetypeById('poppy_humanoid_v1');
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const relationshipsById = new Map(
    relationships.map((relationship) => [relationship.id, relationship]),
  );
  const battery = nodesById.get('comp_poppy_battery');
  assert.equal(battery.category, 'power');
  assert.equal(battery.origin, 'cots_library_step');
  assert.equal(
    battery.ports.find(({ portId }) => portId === 'port_pack_out').nominalVoltageV,
    11.1,
  );

  for (const [cable, source, fromPort, sink, toPort, bus, voltage] of [
    [
      'batt_main',
      'comp_poppy_battery',
      'pack_out',
      'comp_poppy_power_dist',
      'battery_in',
      'dc_power',
      12,
    ],
    ['smps_upper_in', 'comp_poppy_power_dist', 'upper_smps', 'poppy_1_18', 'dc_in', 'dc_power', 12],
    ['smps_lower_in', 'comp_poppy_power_dist', 'lower_smps', 'poppy_1_19', 'dc_in', 'dc_power', 12],
    ['buck_in', 'comp_poppy_power_dist', 'buck_out', 'comp_poppy_5v_buck', 'dc_in', 'dc_power', 12],
    ['xu4_power', 'comp_poppy_5v_buck', '5v_compute', 'poppy_1_28_3', 'dc_in', 'dc_power', 5],
    ['amp_power', 'comp_poppy_5v_buck', '5v_aux', 'comp_poppy_audio_amp', '5v_in', 'dc_power', 5],
    ['audio_in', 'poppy_1_28_3', 'audio_out', 'comp_poppy_audio_amp', 'audio_in', 'analog_audio'],
    ['spk_left', 'comp_poppy_audio_amp', 'spk_left', 'poppy_1_28_10', 'spk_in', 'analog_audio'],
    ['spk_right', 'comp_poppy_audio_amp', 'spk_right', 'poppy_1_28_11', 'spk_in', 'analog_audio'],
    ['display', 'poppy_1_28_3', 'display_out', 'poppy_1_28_7', 'display_in', 'mipi_csi2'],
  ]) {
    const { specifications } = nodesById.get(`comp_poppy_cable_${cable}`);
    const relationship = relationshipsById.get(specifications.relationshipId);
    const isPower = bus === 'dc_power';
    assert.equal(specifications.controller, isPower ? 'power_distribution' : 'head_peripherals');
    assert.equal(relationship.connectionType, isPower ? 'power_bus' : 'electrical_bus');
    assert.equal(relationship.routingStyle, 'filleted_polyline');
    assert.ok(relationship.routingWaypointsMeters.length > 0);
    assert.deepEqual(
      [
        relationship.fromComponentId,
        relationship.fromPortId,
        relationship.toComponentId,
        relationship.toPortId,
      ],
      [source, `port_${fromPort}`, sink, `port_${toPort}`],
    );
    const input = nodesById.get(sink).ports.find(({ portId }) => portId === `port_${toPort}`);
    assert.equal(input.busKind, bus);
    if (isPower) {
      assert.equal(input.nominalVoltageV, voltage);
    }
  }
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
