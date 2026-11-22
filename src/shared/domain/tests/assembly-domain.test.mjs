import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AI_PROVIDER_REGISTRY,
  getAiProviderDescriptor,
  isOpenAiCompatibleProvider,
  parseAiProviderId,
} from '../aiProvider.ts';
import {
  canClassifyAsVerified,
  computeExplodeStageWeight,
  computeNodeWorldPositionMeters,
  toComponentId,
  verifyOneToOneNodeMapping,
} from '../assembly.ts';
import {
  CATALOG_ARCHETYPES,
  getCatalogArchetypeById,
  matchProjectArchetypeFromPrompt,
} from '../catalog.ts';

describe('shared domain contracts', () => {
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

  it('matches extensible robotics archetypes from user prompts', () => {
    assert.ok(CATALOG_ARCHETYPES.length >= 2);
    const drone = matchProjectArchetypeFromPrompt('I want to learn how to build a quadcopter');
    assert.equal(drone.archetypeId, 'quadcopter_drone_v1');

    const arm = matchProjectArchetypeFromPrompt('Build a 3-DOF robotic arm with gripper');
    assert.equal(arm.archetypeId, 'robotic_arm_3dof_v1');
    assert.equal(getCatalogArchetypeById('robotic_arm_3dof_v1')?.nodes.length, 12);
  });

  it('prevents classifying unvalidated or colliding models as verified', () => {
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
    assert.equal(canClassifyAsVerified(validReport, 'synthesized_verified'), true);
    assert.equal(canClassifyAsVerified(validReport, 'unverified'), false);
    assert.equal(
      canClassifyAsVerified({ ...validReport, interferenceCount: 1 }, 'synthesized_verified'),
      false,
    );
    assert.equal(
      canClassifyAsVerified({ ...validReport, maxDimensionalErrorMm: 0.15 }, 'sourced_verified'),
      false,
    );
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
