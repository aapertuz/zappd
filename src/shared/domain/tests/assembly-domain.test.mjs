import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  AI_PROVIDER_REGISTRY,
  getAiProviderDescriptor,
  isOpenAiCompatibleProvider,
  parseAiProviderId,
} from '../aiProvider.ts';
import {
  GEOMETRY_ORIGINS,
  canClassifyAsVerified,
  computeExplodeStageWeight,
  computeNodeWorldPositionMeters,
  hasVerifiedUpstreamProvenance,
  isGeometryOrigin,
  isPortId,
  isVerificationStatus,
  isVerifiedStatus,
  parseAssemblyNode,
  parseConnectorPort,
  parseGeometryOrigin,
  parseRelationship,
  toComponentId,
  toPortId,
  verifyOneToOneNodeMapping,
} from '../assembly.ts';
import {
  CATALOG_ARCHETYPES,
  getCatalogArchetypeById,
  matchProjectArchetypeFromPrompt,
} from '../catalog.ts';

describe('shared domain contracts', () => {
  it('loads the same complete catalog specs as the CAD worker', () => {
    const catalogDirectory = new URL('../catalog/assemblies/', import.meta.url);
    const workerSpecFiles = readdirSync(catalogDirectory).filter((file) => file.endsWith('.json'));
    const appSpecFiles = CATALOG_ARCHETYPES.map(({ archetypeId }) => `${archetypeId}.json`);

    assert.deepEqual(appSpecFiles.toSorted(), workerSpecFiles.toSorted());
    for (const specFile of workerSpecFiles) {
      const workerSpec = JSON.parse(readFileSync(new URL(specFile, catalogDirectory), 'utf8'));
      assert.deepEqual(getCatalogArchetypeById(workerSpec.archetypeId), workerSpec);
    }
  });

  it('routes gemini via google_genai and both openai and deepseek via openai_compatible api', () => {
    assert.equal(getAiProviderDescriptor('gemini').apiFormat, 'google_genai');
    assert.equal(getAiProviderDescriptor('openai').apiFormat, 'openai_compatible');
    assert.equal(getAiProviderDescriptor('deepseek').apiFormat, 'openai_compatible');
    assert.equal(isOpenAiCompatibleProvider('openai'), true);
    assert.equal(isOpenAiCompatibleProvider('deepseek'), true);
    assert.equal(isOpenAiCompatibleProvider('gemini'), false);
    assert.equal(AI_PROVIDER_REGISTRY.deepseek.defaultBaseUrl, 'https://api.deepseek.com');
    assert.equal(parseAiProviderId('deepseek'), 'deepseek');
    assert.throws(() => parseAiProviderId('unknown_provider'));
  });

  it('matches extensible robotics archetypes across aerial, manipulator, and rover categories', () => {
    assert.ok(CATALOG_ARCHETYPES.length >= 3);
    const drone = matchProjectArchetypeFromPrompt('I want to learn how to build a quadcopter');
    assert.equal(drone.archetypeId, 'quadcopter_drone_v1');
    assert.equal(getCatalogArchetypeById('quadcopter_drone_v1')?.nodes.length, 30);

    const arm = matchProjectArchetypeFromPrompt('Build a 5-DOF SO-100 robotic arm with gripper');
    assert.equal(arm.archetypeId, 'robotic_arm_3dof_v1');
    assert.equal(getCatalogArchetypeById('robotic_arm_3dof_v1')?.nodes.length, 24);

    const rover = matchProjectArchetypeFromPrompt(
      'Inspect a planetary rover chassis with stereo camera',
    );
    assert.equal(rover.archetypeId, 'open_source_rover_v1');
    assert.equal(getCatalogArchetypeById('open_source_rover_v1')?.nodes.length, 15);
  });

  it('prevents classifying unvalidated, colliding, or ungrounded models as verified', () => {
    const validReport = {
      valid: true,
      brepValid: true,
      interferenceCount: 0,
      maxDimensionalErrorMm: 0.04,
      nodeMappingComplete: true,
      unitSystem: 'meters_y_up',
      checkedAtIso: '2026-11-22T20:00:00.000Z',
      failures: [],
    };
    assert.equal(canClassifyAsVerified(validReport, 'sourced_verified'), true);
    assert.equal(canClassifyAsVerified(validReport, 'composed_validated'), true);
    assert.equal(canClassifyAsVerified(validReport, 'unverified'), false);
    assert.equal(isVerificationStatus('synthesized_verified'), false);
    assert.equal(isVerificationStatus('composed_validated'), true);
    assert.equal(isVerifiedStatus('composed_validated'), true);
    assert.equal(isVerifiedStatus('unverified'), false);
    assert.equal(
      canClassifyAsVerified({ ...validReport, interferenceCount: 1 }, 'sourced_verified'),
      false,
    );
    assert.equal(
      canClassifyAsVerified({ ...validReport, maxDimensionalErrorMm: 0.15 }, 'sourced_verified'),
      false,
    );
    assert.equal(
      canClassifyAsVerified({ ...validReport, nodeMappingComplete: false }, 'composed_validated'),
      false,
    );
  });

  it('requires each geometry origin to have its own allowed URI and verification status', () => {
    const cases = [
      ['open_step_catalog', 'sourced_verified', ['https://'], ['kicad://', 'harness://']],
      ['cots_library_step', 'sourced_verified', ['https://'], ['kicad://', 'harness://']],
      ['kicad_pcb_step', 'composed_validated', ['https://', 'kicad://'], ['harness://']],
      ['procedural_harness', 'composed_validated', ['https://', 'harness://'], ['kicad://']],
    ];
    const nodeWithProvenance = (provenance) => ({
      provenance: { spdxLicense: 'MIT', stepSha256: 'a'.repeat(64), ...provenance },
    });
    const hasProvenance = (provenance) =>
      hasVerifiedUpstreamProvenance([nodeWithProvenance(provenance)]);

    assert.deepEqual(
      GEOMETRY_ORIGINS,
      cases.map(([origin]) => origin),
    );
    assert.equal(hasVerifiedUpstreamProvenance([]), false);
    assert.equal(isGeometryOrigin('build123d_fallback'), false);
    assert.throws(() => parseGeometryOrigin('build123d_fallback'));

    const validNodes = [];
    for (const [origin, verificationStatus, allowed, denied] of cases) {
      assert.equal(isGeometryOrigin(origin), true);
      assert.equal(parseGeometryOrigin(origin), origin);
      for (const prefix of allowed) {
        const provenance = { origin, verificationStatus, sourceUrl: `${prefix}example.test/part` };
        assert.equal(hasProvenance(provenance), true);
        validNodes.push(nodeWithProvenance(provenance));
      }
      for (const prefix of [...denied, 'http://', 'local://']) {
        assert.equal(
          hasProvenance({ origin, verificationStatus, sourceUrl: `${prefix}example.test/part` }),
          false,
        );
      }
      for (const invalidStatus of ['sourced_verified', 'composed_validated', 'unverified'].filter(
        (status) => status !== verificationStatus,
      )) {
        assert.equal(
          hasProvenance({
            origin,
            verificationStatus: invalidStatus,
            sourceUrl: 'https://example.test/part',
          }),
          false,
        );
      }
    }
    assert.equal(hasVerifiedUpstreamProvenance(validNodes), true);
    assert.equal(hasVerifiedUpstreamProvenance(validNodes, 'composed_validated'), true);
    assert.equal(hasVerifiedUpstreamProvenance(validNodes, 'sourced_verified'), false);
    const sourcedOnlyNodes = validNodes.filter(
      ({ provenance }) => provenance.verificationStatus === 'sourced_verified',
    );
    assert.equal(hasVerifiedUpstreamProvenance(sourcedOnlyNodes, 'sourced_verified'), true);
    assert.equal(hasVerifiedUpstreamProvenance(sourcedOnlyNodes, 'composed_validated'), false);
    const reference = validNodes[0].provenance;
    assert.equal(hasProvenance({ ...reference, origin: 'build123d_fallback' }), false);
    assert.equal(hasProvenance({ ...reference, spdxLicense: '  ' }), false);
    assert.equal(hasProvenance({ ...reference, stepSha256: 'g'.repeat(64) }), false);
  });

  it('parses connector ports and preserves optional ports only on nodes that have them', () => {
    const port = {
      portId: 'port_motor_power',
      label: 'Motor power',
      connectorType: 'XT30',
      busKind: 'dc_power',
      localPositionMeters: [0.01, 0, 0],
      exitDirection: [1, 0, 0],
    };
    assert.equal(isPortId(port.portId), true);
    assert.equal(toPortId(port.portId), port.portId);
    assert.equal(isPortId('Invalid Port'), false);
    assert.throws(() => toPortId('Invalid Port'));
    assert.deepEqual(parseConnectorPort(port), port);
    const wiredPort = {
      ...port,
      wireGaugeAwg: 18,
      wireColorsHex: ['#ff0000', '#000000'],
      nominalVoltageV: 12,
    };
    assert.deepEqual(parseConnectorPort(wiredPort), wiredPort);
    for (const invalidFields of [
      { portId: '' },
      { label: ' ' },
      { busKind: 'analog' },
      { localPositionMeters: [0, 0] },
      { exitDirection: [0, 0, 0] },
      { exitDirection: [1, 0, Infinity] },
      { wireColorsHex: ['red'] },
      { wireGaugeAwg: NaN },
    ]) {
      assert.throws(() => parseConnectorPort({ ...port, ...invalidFields }));
    }

    const blueprint = getCatalogArchetypeById('quadcopter_drone_v1').nodes[0];
    const node = {
      ...blueprint,
      provenance: {
        origin: blueprint.origin,
        verificationStatus: 'sourced_verified',
        spdxLicense: blueprint.spdxLicense,
        sourceUrl: blueprint.sourceUrl,
        sourceName: blueprint.sourceName,
        stepSha256: 'a'.repeat(64),
      },
      glbNodeName: blueprint.id,
      usdzPrimPath: `/World/${blueprint.id}`,
    };
    assert.equal(Object.hasOwn(parseAssemblyNode(node), 'ports'), false);
    assert.deepEqual(parseAssemblyNode({ ...node, ports: [wiredPort] }).ports, [wiredPort]);
    assert.throws(() => parseAssemblyNode({ ...node, ports: [null] }));
  });

  it('parses electrical routing with a complete port pair and positive finite bundle diameter', () => {
    const relationship = {
      id: 'rel_motor_power',
      fromComponentId: 'comp_motor',
      toComponentId: 'comp_controller',
      connectionType: 'power_bus',
      howConnected: 'XT30',
      whyConnected: 'Powers the motor',
    };
    assert.deepEqual(parseRelationship(relationship), relationship);
    const routed = {
      ...relationship,
      fromPortId: 'port_motor_power',
      toPortId: 'port_controller_out',
      routingWaypointsMeters: [[0.01, 0.02, 0.03]],
      wireBundleDiameterMm: 5,
    };
    assert.deepEqual(parseRelationship(routed), routed);
    assert.throws(() => parseRelationship({ ...relationship, fromPortId: routed.fromPortId }));
    assert.throws(() => parseRelationship({ ...relationship, toPortId: routed.toPortId }));
    assert.throws(() => parseRelationship({ ...routed, toPortId: 'Invalid Port' }));
    assert.throws(() => parseRelationship({ ...routed, routingWaypointsMeters: [[0, 0]] }));
    for (const wireBundleDiameterMm of [0, -1, Infinity, NaN, '5']) {
      assert.throws(() => parseRelationship({ ...routed, wireBundleDiameterMm }));
    }
  });

  it('computes hierarchical constraint-axis explosion by assembly depth without axial drift', () => {
    const drone = matchProjectArchetypeFromPrompt('quadcopter');
    const nodesById = {};
    for (const bp of drone.nodes) {
      nodesById[bp.id] = {
        ...bp,
        provenance: {
          origin: bp.origin,
          verificationStatus: 'sourced_verified',
          spdxLicense: bp.spdxLicense,
          sourceUrl: bp.sourceUrl,
          sourceName: bp.sourceName,
          stepSha256: 'a'.repeat(64),
        },
        glbNodeName: bp.id,
        usdzPrimPath: `/World/${bp.id}`,
      };
    }

    assert.equal(computeExplodeStageWeight(1, 0, 'all'), 0);
    assert.equal(computeExplodeStageWeight(2, 0.1, 'all'), 0);
    assert.equal(computeExplodeStageWeight(3, 0.35, 'all'), 0);

    const motor = nodesById[toComponentId('comp_motor_fl')];
    const prop = nodesById[toComponentId('subcomp_prop_fl')];
    const motorAtFull = computeNodeWorldPositionMeters(motor, nodesById, 1, {}, 'all');
    const propAtFull = computeNodeWorldPositionMeters(prop, nodesById, 1, {}, 'all');

    assert.equal(motorAtFull[0], motor.restPositionMeters[0]);
    assert.equal(propAtFull[0], prop.restPositionMeters[0]);
    assert.equal(motorAtFull[2], motor.restPositionMeters[2]);
    assert.equal(propAtFull[2], prop.restPositionMeters[2]);
    assert.ok(propAtFull[1] > motorAtFull[1]);

    const separated = computeNodeWorldPositionMeters(
      motor,
      nodesById,
      0,
      { comp_motor_fl: [0, 0.08, 0] },
      'all',
    );
    assert.ok(Math.abs(separated[1] - (motor.restPositionMeters[1] + 0.08)) < 1e-6);

    const leafIds = drone.nodes
      .filter((n) => n.level === 'component' || n.level === 'subcomponent')
      .map((n) => n.id);
    const glbIds = [...leafIds];
    const usdzPrims = leafIds.map((id) => `/World/${id}`);
    assert.equal(verifyOneToOneNodeMapping(Object.values(nodesById), glbIds, usdzPrims), true);
    assert.equal(
      verifyOneToOneNodeMapping(Object.values(nodesById), glbIds.slice(1), usdzPrims),
      false,
    );
  });
});
