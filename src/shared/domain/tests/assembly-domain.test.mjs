import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import { COTS_CATALOG_PARTS, getCotsPartById, searchCotsParts } from '@/shared/domain';

import {
  AI_PROVIDER_REGISTRY,
  getAiProviderDescriptor,
  isOpenAiCompatibleProvider,
  parseAiProviderId,
} from '../aiProvider.ts';
import {
  GEOMETRY_ORIGINS,
  canClassifyAsVerified,
  clampAssemblyParameterValues,
  computeExplodeStageWeight,
  computeNodeWorldPositionMeters,
  hasVerifiedUpstreamProvenance,
  isGeometryOrigin,
  isMountingInterfaceId,
  isParameterName,
  isPortId,
  isVerificationStatus,
  isVerifiedStatus,
  parseAssemblyNode,
  parseAssemblyParameter,
  parseConnectorPort,
  parseGeometryOrigin,
  parseMountingInterface,
  parseRelationship,
  parseVerifiedProjectAssembly,
  toComponentId,
  toMountingInterfaceId,
  toParameterName,
  toPortId,
  verifyOneToOneNodeMapping,
} from '../assembly.ts';
import {
  CATALOG_ARCHETYPES,
  getCatalogArchetypeById,
  matchProjectArchetypeFromPrompt,
  parseCatalogArchetype,
} from '../catalog.ts';
import { cotsPartSpecSchema } from '../cotsCatalog.ts';

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

const mountingInterface = {
  interfaceId: 'mount-pcb_01',
  label: 'Flight controller mount',
  kind: 'm3_standoff',
  holeDiameterMm: 3.2,
  boltPitchMm: [30.5, 30.5],
  localPositionMeters: [0.01525, 0, -0.01525],
  normalDirection: [0, 1, 0],
};

const parameter = {
  name: 'arm_length',
  label: 'Arm length',
  kind: 'float',
  defaultValue: 120,
  value: 125,
  min: 100,
  max: 150,
  step: 2.5,
  unit: 'mm',
};

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
    assert.equal(getCatalogArchetypeById('quadcopter_drone_v1')?.nodes.length, 42);

    const arm = matchProjectArchetypeFromPrompt('Build a 5-DOF SO-100 robotic arm with gripper');
    assert.equal(arm.archetypeId, 'robotic_arm_3dof_v1');
    assert.equal(getCatalogArchetypeById('robotic_arm_3dof_v1')?.nodes.length, 31);

    const rover = matchProjectArchetypeFromPrompt(
      'Inspect a planetary rover chassis with stereo camera',
    );
    assert.equal(rover.archetypeId, 'open_source_rover_v1');
    assert.equal(getCatalogArchetypeById('open_source_rover_v1')?.nodes.length, 21);
  });

  it('prevents classifying unvalidated, colliding, or ungrounded models as verified', () => {
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

  it('rejects connectivity or electrical failures for both verified statuses', () => {
    const report = {
      ...validReport,
      connectivityValid: true,
      floatingComponentIds: [],
      electricalValid: true,
      electricalFailures: [],
    };
    for (const status of ['sourced_verified', 'composed_validated']) {
      assert.equal(canClassifyAsVerified(report, status), true);
      for (const failure of [
        { connectivityValid: false },
        { floatingComponentIds: ['comp_motor'] },
        { electricalValid: false },
        { electricalFailures: ['Motor voltage exceeds controller output range'] },
      ]) {
        assert.equal(canClassifyAsVerified({ ...report, ...failure }, status), false);
      }
    }
  });

  it('requires each geometry origin to have its own allowed URI and verification status', () => {
    const cases = [
      [
        'open_step_catalog',
        'sourced_verified',
        ['https://'],
        ['kicad://', 'harness://', 'parametric://'],
      ],
      [
        'cots_library_step',
        'sourced_verified',
        ['https://'],
        ['kicad://', 'harness://', 'parametric://'],
      ],
      [
        'kicad_pcb_step',
        'composed_validated',
        ['https://', 'kicad://'],
        ['harness://', 'parametric://'],
      ],
      [
        'procedural_harness',
        'composed_validated',
        ['https://', 'harness://'],
        ['kicad://', 'parametric://'],
      ],
      [
        'parametric_cad',
        'composed_validated',
        ['https://', 'parametric://'],
        ['kicad://', 'harness://'],
      ],
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
    for (const node of validNodes.filter(
      ({ provenance }) => provenance.verificationStatus === 'composed_validated',
    )) {
      const mixedNodes = [...sourcedOnlyNodes, node];
      assert.equal(hasVerifiedUpstreamProvenance(mixedNodes, 'composed_validated'), true);
      assert.equal(hasVerifiedUpstreamProvenance(mixedNodes, 'sourced_verified'), false);
    }
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
    const ratedPort = {
      ...wiredPort,
      role: 'sink',
      minVoltageV: 0,
      maxVoltageV: 15,
      maxCurrentA: 2.5,
      compatibleBusKinds: ['dc_power', 'usb_data'],
    };
    for (const role of ['source', 'sink', 'bidirectional']) {
      const portWithRole = { ...ratedPort, role };
      assert.deepEqual(parseConnectorPort(portWithRole), portWithRole);
    }
    assert.equal(parseConnectorPort({ ...port, maxVoltageV: 0 }).maxVoltageV, 0);
    assert.equal(parseConnectorPort({ ...port, minVoltageV: 5, maxVoltageV: 5 }).maxVoltageV, 5);
    for (const invalidFields of [
      { portId: '' },
      { label: ' ' },
      { busKind: 'analog' },
      { localPositionMeters: [0, 0] },
      { exitDirection: [0, 0, 0] },
      { exitDirection: [1, 0, Infinity] },
      { wireColorsHex: ['red'] },
      { wireGaugeAwg: NaN },
      { role: 'passive' },
      { minVoltageV: -1 },
      { maxVoltageV: -1 },
      { maxVoltageV: Infinity },
      { minVoltageV: NaN },
      { minVoltageV: 15, maxVoltageV: 12 },
      { maxCurrentA: 0 },
      { maxCurrentA: -1 },
      { maxCurrentA: Infinity },
      { compatibleBusKinds: ['analog'] },
    ]) {
      assert.throws(() => parseConnectorPort({ ...ratedPort, ...invalidFields }));
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
    assert.deepEqual(parseAssemblyNode({ ...node, ports: [ratedPort] }).ports, [ratedPort]);
    assert.throws(() => parseAssemblyNode({ ...node, ports: [null] }));
    assert.equal(Object.hasOwn(parseAssemblyNode(node), 'restRotationDeg'), false);
    assert.equal(Object.hasOwn(parseAssemblyNode(node), 'mountingInterfaces'), false);
    const oriented = {
      ...node,
      restRotationDeg: [-90, 0, 180],
      mountingInterfaces: [mountingInterface],
    };
    assert.deepEqual(parseAssemblyNode(oriented).restRotationDeg, [-90, 0, 180]);
    assert.deepEqual(parseAssemblyNode(oriented).mountingInterfaces, [mountingInterface]);
    for (const restRotationDeg of [[0, 0], [0, 0, NaN], [0, Infinity, 0], null]) {
      assert.throws(() => parseAssemblyNode({ ...oriented, restRotationDeg }));
    }
    assert.throws(() => parseAssemblyNode({ ...oriented, mountingInterfaces: [null] }));
  });

  it('validates mounting IDs, kinds, pitches, and nonzero directions', () => {
    assert.equal(isMountingInterfaceId(mountingInterface.interfaceId), true);
    assert.equal(
      toMountingInterfaceId(mountingInterface.interfaceId),
      mountingInterface.interfaceId,
    );
    for (const invalidId of ['mount PCB', 'M3_mount', 'm', '', null]) {
      assert.equal(isMountingInterfaceId(invalidId), false);
      assert.throws(() => toMountingInterfaceId(invalidId));
    }
    for (const kind of ['m2_standoff', 'm2_5_standoff', 'm3_standoff', 'slot', 'flange', 'clamp']) {
      const mount = { ...mountingInterface, kind };
      assert.deepEqual(parseMountingInterface(mount), mount);
    }
    const mountWithoutPitch = { ...mountingInterface };
    delete mountWithoutPitch.boltPitchMm;
    assert.deepEqual(parseMountingInterface(mountWithoutPitch), mountWithoutPitch);
    for (const invalidFields of [
      { interfaceId: 'Mount' },
      { label: '' },
      { kind: 'magnet' },
      { holeDiameterMm: 0 },
      { holeDiameterMm: Infinity },
      { boltPitchMm: [30] },
      { boltPitchMm: [-1, 30] },
      { boltPitchMm: [30, Infinity] },
      { localPositionMeters: [0, 0, NaN] },
      { normalDirection: [0, 0, 0] },
      { normalDirection: [0, 1, Infinity] },
      { unknownField: true },
    ]) {
      assert.throws(() => parseMountingInterface({ ...mountingInterface, ...invalidFields }));
    }
  });

  it('validates declarative parameters and generation modes in catalog specs', () => {
    assert.equal(isParameterName('a'), true);
    assert.equal(isParameterName('a'.repeat(48)), true);
    assert.equal(toParameterName(parameter.name), parameter.name);
    for (const invalidName of ['a'.repeat(49), '0arm', 'arm-length', 'Arm', '', null]) {
      assert.equal(isParameterName(invalidName), false);
      assert.throws(() => toParameterName(invalidName));
    }
    assert.deepEqual(parseAssemblyParameter({ ...parameter, label: '  Arm length  ' }), parameter);
    for (const invalidFields of [
      { name: 'ARM' },
      { label: ' ' },
      { kind: 'string' },
      { min: 150 },
      { max: 99 },
      { max: Infinity },
      { defaultValue: 99 },
      { defaultValue: NaN },
      { value: 151 },
      { value: '125' },
      { step: 0 },
      { step: Infinity },
      { unit: 'cm' },
      { unknownField: true },
    ]) {
      assert.throws(() => parseAssemblyParameter({ ...parameter, ...invalidFields }));
    }
    const intParameter = { ...parameter, kind: 'int', unit: 'count', step: 2 };
    assert.deepEqual(parseAssemblyParameter(intParameter), intParameter);
    for (const field of ['defaultValue', 'value', 'min', 'max', 'step']) {
      assert.throws(() =>
        parseAssemblyParameter({ ...intParameter, [field]: intParameter[field] + 0.5 }),
      );
    }
    assert.equal(parseAssemblyParameter({ ...parameter, unit: 'deg' }).unit, 'deg');
    const archetype = getCatalogArchetypeById('quadcopter_drone_v1');
    for (const generationMode of ['reference_catalog', 'parametric_family']) {
      const extended = { ...archetype, generationMode, parameters: [parameter] };
      assert.deepEqual(parseCatalogArchetype(extended), extended);
    }
    assert.throws(() => parseCatalogArchetype({ ...archetype, generationMode: 'unknown' }));
    assert.throws(() =>
      parseCatalogArchetype({ ...archetype, parameters: [{ ...parameter, step: 0 }] }),
    );
  });

  it('clamps and snaps finite overrides without mutating parameter definitions', () => {
    const armLength = Object.freeze({ ...parameter, min: 101, max: 151 });
    const count = Object.freeze({
      name: 'wheel_count',
      label: 'Wheel count',
      kind: 'int',
      defaultValue: 4,
      value: 4,
      min: 2,
      max: 8,
      step: 2,
      unit: 'count',
    });
    const parameters = Object.freeze([armLength, count]);
    assert.deepEqual(
      clampAssemblyParameterValues(parameters, { arm_length: 122, wheel_count: 7.4 }),
      {
        arm_length: 121,
        wheel_count: 8,
      },
    );
    assert.deepEqual(
      clampAssemblyParameterValues(parameters, { arm_length: 999, wheel_count: -1 }),
      {
        arm_length: 151,
        wheel_count: 2,
      },
    );
    assert.deepEqual(
      clampAssemblyParameterValues(parameters, {
        arm_length: Infinity,
        wheel_count: '6',
        unknown: 9,
      }),
      { arm_length: 125, wheel_count: 4 },
    );
    assert.deepEqual(clampAssemblyParameterValues(parameters, Object.create({ wheel_count: 8 })), {
      arm_length: 125,
      wheel_count: 4,
    });
  });

  it('round-trips optional parameters and validation diagnostics through the project parser', () => {
    const archetypeId = 'quadcopter_drone_v1';
    const hash = 'a'.repeat(64);
    const timestamp = validReport.checkedAtIso;
    const files = Object.fromEntries(
      ['step', 'glb', 'usdz'].map((format) => [
        format,
        {
          format,
          storagePath: `assemblies/${hash}/assembly.${format}`,
          publicUrl: `/assemblies/${hash}/assembly.${format}`,
          sha256: hash,
          sizeBytes: 1024,
        },
      ]),
    );
    const project = {
      projectId: 'project_drone',
      archetypeId,
      title: 'Quadcopter',
      userPrompt: 'Assemble a quadcopter',
      verificationStatus: 'composed_validated',
      rootNodeId: 'project_quad',
      nodes: [],
      relationships: [],
      assemblySteps: [],
      manifest: { manifestHash: hash, archetypeId, generatedAtIso: timestamp, files },
      validation: validReport,
      orchestration: {
        provider: 'gemini',
        modelId: 'catalog-planner',
        apiFormat: 'google_genai',
        baseUrl: 'https://generativelanguage.googleapis.com',
        executionMode: 'local_catalog_planner',
        plannedSubsystems: ['Propulsion'],
      },
    };
    assert.deepEqual(parseVerifiedProjectAssembly(project), project);
    const diagnostics = {
      ...validReport,
      connectivityValid: false,
      floatingComponentIds: ['comp_motor'],
      electricalValid: false,
      electricalFailures: ['Motor voltage mismatch'],
      repairAttempts: 2,
      visualRenderPaths: [`/assemblies/${hash}/front.png`],
    };
    const extended = {
      ...project,
      verificationStatus: 'unverified',
      parameters: [parameter],
      parameterValues: { arm_length: 125 },
    };
    for (const cacheMode of ['cold_step', 'xbf_disk', 'warm_ram']) {
      const result = {
        ...extended,
        validation: { ...diagnostics, buildTimingMs: { totalMs: 32.5, cacheMode } },
      };
      assert.deepEqual(parseVerifiedProjectAssembly(result), result);
    }
    for (const invalidFields of [
      { connectivityValid: 'false' },
      { floatingComponentIds: ['Invalid Id'] },
      { electricalValid: 0 },
      { electricalFailures: [null] },
      { repairAttempts: -1 },
      { repairAttempts: 0.5 },
      { visualRenderPaths: [42] },
      { buildTimingMs: { totalMs: -1, cacheMode: 'cold_step' } },
      { buildTimingMs: { totalMs: 5, cacheMode: 'unknown' } },
    ]) {
      assert.throws(() =>
        parseVerifiedProjectAssembly({
          ...extended,
          validation: { ...diagnostics, ...invalidFields },
        }),
      );
    }
    assert.throws(() =>
      parseVerifiedProjectAssembly({ ...extended, parameterValues: { arm_length: NaN } }),
    );
    assert.throws(() =>
      parseVerifiedProjectAssembly({ ...extended, parameters: [{ ...parameter, step: 0 }] }),
    );
  });

  it('loads the shared COTS registry and searches by provenance, ports, mounting, size, and text', () => {
    const workerParts = JSON.parse(
      readFileSync(new URL('../catalog/cots/index.json', import.meta.url), 'utf8'),
    );
    assert.deepEqual(COTS_CATALOG_PARTS, workerParts);
    assert.deepEqual(searchCotsParts({ text: ' ' }), workerParts);
    const battery = getCotsPartById('cots_battery_3s_18650');
    const esc = getCotsPartById('kicad_quad_4in1_esc');
    assert.equal(battery.name, '3S 18650 battery holder with cells');
    assert.equal(getCotsPartById('missing_part'), undefined);
    assert.deepEqual(searchCotsParts({ busKind: 'brushless_phase' }), [esc]);
    assert.deepEqual(searchCotsParts({ origin: 'cots_library_step' }), [battery]);
    assert.deepEqual(searchCotsParts({ text: '  BRuSHLeSS Esc  ' }), [esc]);
    assert.deepEqual(searchCotsParts({ text: 'kicad_quad_4in1_esc' }), [esc]);
    const hub = getCotsPartById('kicad_quadruped_servo_hub');
    assert.deepEqual(hub.mountingInterfaces[0].boltPitchMm, [64, 48]);
    assert.equal(hub.ports.filter(({ busKind }) => busKind === 'pwm_signal').length, 12);
    assert.deepEqual(
      searchCotsParts({
        busKind: 'pwm_signal',
        mountingKind: 'm3_standoff',
        origin: 'kicad_pcb_step',
        maxDimensionMm: 72,
        text: '  OPEN-Quadruped ',
      }),
      [hub],
    );
    assert.deepEqual(searchCotsParts({ text: 'open-quadruped', maxDimensionMm: 71 }), []);
    const batteryOutput = battery.ports.find(({ portId }) => portId === 'port_pack_out');
    assert.equal(batteryOutput.role, 'source');
    assert.equal(batteryOutput.nominalVoltageV, 11.1);
    assert.deepEqual(
      searchCotsParts({
        busKind: 'dc_power',
        origin: 'kicad_pcb_step',
        maxDimensionMm: 36,
        text: 'quadcopter',
      }),
      [esc],
    );
    assert.deepEqual(searchCotsParts({ busKind: 'brushless_phase', maxDimensionMm: 35.9 }), []);

    const extended = {
      ...esc,
      mountingInterfaces: [mountingInterface],
      category: 'motor control',
      tags: ['quadcopter'],
    };
    assert.deepEqual(cotsPartSpecSchema.parse(extended), extended);
    for (const invalidFields of [
      { unknownField: true },
      { expectedStepSha256: 'invalid' },
      { sourceUrl: 'parametric://zappd/esc' },
      { dimensionsMm: [20, 0, 30] },
      { ports: [null] },
      { mountingInterfaces: [null] },
      { tags: [' '] },
    ]) {
      assert.throws(() => cotsPartSpecSchema.parse({ ...extended, ...invalidFields }));
    }
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
