import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CATALOG_ARCHETYPES,
  QUADCOPTER_ARCHETYPE,
  ROBOTIC_ARM_ARCHETYPE,
  ROVER_ARCHETYPE,
} from '@/shared/domain';

import { computeLearningCalloutsLayout } from '../model/calloutLayout.ts';
import { INITIAL_LEARNING_STATE, reduceLearningState } from '../model/learningState.ts';
import { classifyCanvasPrompt } from '../model/promptRouter.ts';
import { advanceTypewriterProgress, isTypewriterWriting } from '../model/typewriter.ts';

describe('learning callout state', () => {
  it('restores completed overview and part explanations until the project resets', () => {
    const root = {
      type: 'activateExplanation',
      componentId: QUADCOPTER_ARCHETYPE.rootNodeId,
      componentName: QUADCOPTER_ARCHETYPE.title,
    };
    const part = {
      ...root,
      componentId: 'comp_motor_rr',
      componentName: 'Rear Right Brushless Motor',
    };
    const overview = reduceLearningState(INITIAL_LEARNING_STATE, root);
    assert.equal(overview.explanation.kind, 'loading');
    assert.equal(overview.explanation.componentId, root.componentId);
    const metadata = { contextSource: 'offline_cache', inferenceSource: 'on_device' };
    const complete = (state, text) =>
      reduceLearningState(state, {
        type: 'complete',
        slot: 'explanation',
        requestId: state.explanation.requestId,
        text,
        ...metadata,
      });

    const overviewText = 'This drone uses four propellers.';
    const partText = 'This motor turns the rear right propeller.';
    const completedOverview = complete(overview, overviewText);
    assert.deepEqual(completedOverview.cachedExplanations[root.componentId], {
      componentId: root.componentId,
      componentName: root.componentName,
      text: overviewText,
      ...metadata,
    });
    const firstFocus = reduceLearningState(completedOverview, part);
    assert.equal(firstFocus.explanation.kind, 'loading');
    const restored = reduceLearningState(firstFocus, root);
    assert.deepEqual(restored.explanation, {
      kind: 'ready',
      requestId: firstFocus.nextRequestId,
      componentId: root.componentId,
      componentName: root.componentName,
      question: undefined,
      restoredFromCache: true,
      text: overviewText,
      ...metadata,
    });
    assert.equal(
      reduceLearningState(restored, {
        type: 'complete',
        slot: 'explanation',
        requestId: firstFocus.explanation.requestId,
        text: partText,
        ...metadata,
      }),
      restored,
    );

    const secondFocus = reduceLearningState(restored, part);
    assert.equal(secondFocus.explanation.kind, 'loading');
    const completedPart = complete(secondFocus, partText);
    const secondOverview = reduceLearningState(completedPart, root);
    for (const slot of ['answer', 'explanation']) {
      const resetSlot = reduceLearningState(secondOverview, { type: 'reset', slot });
      const cachedPart = reduceLearningState(resetSlot, part);
      assert.equal(cachedPart.explanation.kind, 'ready');
      assert.equal(cachedPart.explanation.restoredFromCache, true);
      assert.equal(cachedPart.explanation.text, partText);
    }

    const nextProject = reduceLearningState(completedPart, { type: 'reset' });
    assert.deepEqual(nextProject.cachedExplanations, {});
    assert.equal(reduceLearningState(nextProject, root).explanation.kind, 'loading');
  });

  it('tracks concurrent explanation and answer lifecycles by request and slot', () => {
    const componentId = 'comp_motor_fl';
    const componentName = 'Front Left Motor';
    const loadingExplanation = reduceLearningState(INITIAL_LEARNING_STATE, {
      type: 'start',
      slot: 'explanation',
      componentId,
      componentName,
    });
    const question = 'How is it mounted?';
    const loadingBoth = reduceLearningState(loadingExplanation, {
      type: 'start',
      slot: 'answer',
      componentId,
      componentName,
      question,
    });

    assert.equal(loadingBoth.explanation.kind, 'loading');
    assert.equal(loadingBoth.answer.kind, 'loading');
    assert.equal(loadingBoth.answer.question, question);
    assert.notEqual(loadingBoth.explanation.requestId, loadingBoth.answer.requestId);

    const writing = reduceLearningState(loadingBoth, {
      type: 'write',
      slot: 'explanation',
      requestId: loadingBoth.explanation.requestId,
      text: 'The motor',
      contextSource: 'firestore',
      inferenceSource: 'on_device',
    });
    assert.equal(writing.explanation.kind, 'writing');
    assert.equal(writing.explanation.text, 'The motor');
    assert.equal(writing.answer, loadingBoth.answer);

    const ready = reduceLearningState(writing, {
      type: 'complete',
      slot: 'explanation',
      requestId: writing.explanation.requestId,
      text: 'The motor seats in the arm.',
      contextSource: 'firestore',
      inferenceSource: 'cloud',
      fallbackReason: 'On-device response was too short.',
      providerName: 'DeepSeek',
    });
    assert.equal(ready.explanation.kind, 'ready');
    assert.equal(ready.explanation.inferenceSource, 'cloud');
    assert.equal(ready.explanation.providerName, 'DeepSeek');
    assert.equal(ready.explanation.text, 'The motor seats in the arm.');

    const failed = reduceLearningState(ready, {
      type: 'fail',
      slot: 'answer',
      requestId: ready.answer.requestId,
      message: 'No saved records.',
    });
    assert.equal(failed.answer.kind, 'error');
    assert.equal(failed.answer.message, 'No saved records.');
    assert.equal(failed.answer.question, question);
    assert.equal(failed.explanation, ready.explanation);
  });

  it('drops late writes, completions, and errors after a selection change, reset, or terminal result', () => {
    const first = reduceLearningState(INITIAL_LEARNING_STATE, {
      type: 'start',
      slot: 'explanation',
      componentId: 'comp_motor_fl',
      componentName: 'Front Left Motor',
    });
    const second = reduceLearningState(first, {
      type: 'start',
      slot: 'explanation',
      componentId: 'comp_motor_rr',
      componentName: 'Rear Right Motor',
    });
    const late = {
      slot: 'explanation',
      requestId: first.explanation.requestId,
      text: 'Old answer.',
      contextSource: 'firestore',
      inferenceSource: 'on_device',
    };
    assert.equal(reduceLearningState(second, { ...late, type: 'write' }), second);
    assert.equal(reduceLearningState(second, { ...late, type: 'complete' }), second);
    assert.equal(
      reduceLearningState(second, { ...late, type: 'fail', message: 'Old failure' }),
      second,
    );

    const completed = reduceLearningState(second, {
      ...late,
      type: 'complete',
      text: 'Current answer.',
      requestId: second.explanation.requestId,
    });
    assert.equal(completed.explanation.kind, 'ready');
    assert.equal(
      reduceLearningState(completed, {
        ...late,
        type: 'write',
        requestId: second.explanation.requestId,
      }),
      completed,
    );

    const reset = reduceLearningState(completed, { type: 'reset' });
    assert.equal(reset.explanation.kind, 'idle');
    assert.equal(reset.answer.kind, 'idle');
    assert.equal(reset.nextRequestId, completed.nextRequestId);
    assert.equal(
      reduceLearningState(reset, {
        ...late,
        type: 'complete',
        requestId: second.explanation.requestId,
      }),
      reset,
    );
  });
});

describe('canvas prompt routing', () => {
  const drone = { assembly: QUADCOPTER_ARCHETYPE };
  const rover = { assembly: ROVER_ARCHETYPE };
  const arm = { assembly: ROBOTIC_ARM_ARCHETYPE, focusedComponentId: 'comp_upper_arm_link' };

  it('loads for an empty canvas and recognizes explicit catalog commands in overview', () => {
    assert.deepEqual(classifyCanvasPrompt('Explain the arms', null), { kind: 'load_assembly' });
    assert.deepEqual(classifyCanvasPrompt('Build a 5-DOF SO-100 robotic arm', drone), {
      kind: 'load_assembly',
    });
    assert.deepEqual(classifyCanvasPrompt('Inspect a planetary rover', drone), {
      kind: 'load_assembly',
    });
    assert.deepEqual(classifyCanvasPrompt('Please switch to the quadcopter', rover), {
      kind: 'load_assembly',
    });
  });

  it('targets a named component in overview and defaults general questions to the project', () => {
    const motor = QUADCOPTER_ARCHETYPE.nodes.find(({ id }) => id === 'comp_motor_rr');
    assert.deepEqual(classifyCanvasPrompt(`How does the ${motor.name} work?`, drone), {
      kind: 'ask_question',
      targetComponentId: motor.id,
    });
    assert.deepEqual(classifyCanvasPrompt(`Explain the ${motor.name}`, drone), {
      kind: 'ask_question',
      targetComponentId: motor.id,
    });
    assert.equal(
      classifyCanvasPrompt('Show me how the quadcopter motor works', drone).kind,
      'ask_question',
    );
    assert.deepEqual(classifyCanvasPrompt('Inspect the rover?', drone), {
      kind: 'ask_question',
      targetComponentId: QUADCOPTER_ARCHETYPE.rootNodeId,
    });
    assert.deepEqual(classifyCanvasPrompt('Tell me what this does', drone), {
      kind: 'ask_question',
      targetComponentId: QUADCOPTER_ARCHETYPE.rootNodeId,
    });
  });

  it('keeps focus for questions and component commands and switches for a different archetype', () => {
    for (const prompt of [
      'How does the rover steer?',
      'Inspect the elbow servo',
      'Inspect the motor on a rover',
      'Build this robotic arm',
      'Explain the base joint',
    ]) {
      assert.deepEqual(classifyCanvasPrompt(prompt, arm), {
        kind: 'ask_question',
        targetComponentId: arm.focusedComponentId,
      });
    }
    assert.deepEqual(classifyCanvasPrompt('Load a quadcopter', arm), { kind: 'load_assembly' });
    assert.deepEqual(classifyCanvasPrompt('Build a 5-DOF SO-100 robotic arm', arm), {
      kind: 'load_assembly',
    });
    assert.deepEqual(classifyCanvasPrompt('Inspect a planetary rover', arm), {
      kind: 'load_assembly',
    });
    assert.deepEqual(classifyCanvasPrompt('Inspect a four-legged quadruped', arm), {
      kind: 'load_assembly',
    });
  });

  it('has a documented connection for every selectable part in documented assemblies', () => {
    for (const assembly of CATALOG_ARCHETYPES.filter(
      (entry) => entry.semantics !== 'source_inspection',
    )) {
      const connected = new Set(
        assembly.relationships.flatMap(({ fromComponentId, toComponentId }) => [
          fromComponentId,
          toComponentId,
        ]),
      );
      assert.deepEqual(
        assembly.nodes.filter(
          ({ stepFixtureName, id }) => stepFixtureName !== null && !connected.has(id),
        ),
        [],
        assembly.archetypeId,
      );
    }
  });

  it('installs each cable in a step that documents its typed electrical connection', () => {
    for (const assembly of CATALOG_ARCHETYPES) {
      const nodes = new Map(assembly.nodes.map((node) => [node.id, node]));
      const relationships = new Map(
        assembly.relationships.map((relationship) => [relationship.id, relationship]),
      );
      for (const cable of nodes.values()) {
        if (cable.origin !== 'procedural_harness') continue;
        const electrical = relationships.get(cable.specifications.relationshipId);
        assert.ok(electrical, cable.id);
        const firstPort = nodes
          .get(electrical.fromComponentId)
          ?.ports?.find(({ portId }) => portId === electrical.fromPortId);
        const secondPort = nodes
          .get(electrical.toComponentId)
          ?.ports?.find(({ portId }) => portId === electrical.toPortId);
        assert.ok(firstPort && secondPort, cable.id);
        assert.equal(firstPort.busKind, secondPort.busKind, cable.id);
        assert.equal(
          electrical.connectionType,
          firstPort.busKind === 'dc_power' ? 'power_bus' : 'electrical_bus',
        );
        assert.ok(
          assembly.assemblySteps.some(
            ({ componentIds, relationshipIds }) =>
              componentIds.includes(cable.id) && relationshipIds.includes(electrical.id),
          ),
          cable.id,
        );
      }
    }
  });

  it('records symmetric drone and rover relationships in the matching assembly steps', () => {
    for (const side of ['fl', 'fr', 'rl', 'rr']) {
      const components = [
        ['arm', `comp_arm_${side}`, 'comp_base_plate_lower', `rel_arm_${side}_chassis`],
        ['motor', `comp_motor_${side}`, `comp_arm_${side}`, `rel_motor_${side}_arm`],
        ['propeller', `subcomp_prop_${side}`, `comp_motor_${side}`, `rel_prop_${side}_motor`],
        ['cover', `subcomp_prop_cover_${side}`, `subcomp_prop_${side}`, `rel_cover_${side}_prop`],
      ];
      for (const [label, source, target, id] of components) {
        const relationship = QUADCOPTER_ARCHETYPE.relationships.find((record) => record.id === id);
        assert.equal(relationship?.fromComponentId, source, label);
        assert.equal(relationship?.toComponentId, target, label);
        assert.ok(
          QUADCOPTER_ARCHETYPE.assemblySteps.some(({ relationshipIds }) =>
            relationshipIds.includes(id),
          ),
        );
      }
    }
    for (const side of ['left', 'right']) {
      for (const [kind, source] of [
        ['steering', 'comp_steering_servo'],
        ['axle', 'subcomp_axle_flange'],
      ]) {
        const id = `rel_nova2_${kind}_${side}`;
        const relationship = ROVER_ARCHETYPE.relationships.find((record) => record.id === id);
        assert.equal(relationship?.fromComponentId, `${source}_${side}`);
        assert.equal(relationship?.toComponentId, `comp_wheel_bracket_${side}`);
        assert.ok(
          ROVER_ARCHETYPE.assemblySteps.some(({ relationshipIds }) => relationshipIds.includes(id)),
        );
      }
    }
  });
});

describe('typewriter progress', () => {
  it('carries fractional progress across frames and resumes when streaming text grows', () => {
    const settings = { targetText: 'Motor', dtMs: 16, charsPerSecond: 20, reducedMotion: false };
    let currentVisibleLength = 0;
    for (let frame = 0; frame < 4; frame += 1) {
      currentVisibleLength = advanceTypewriterProgress({ ...settings, currentVisibleLength });
    }
    assert.equal(settings.targetText.slice(0, currentVisibleLength), 'M');
    assert.equal(isTypewriterWriting({ ...settings, currentVisibleLength }), true);
    currentVisibleLength = advanceTypewriterProgress({
      ...settings,
      dtMs: 1000,
      currentVisibleLength,
    });
    assert.equal(currentVisibleLength, 5);
    assert.equal(isTypewriterWriting({ ...settings, currentVisibleLength }), false);

    const streaming = { ...settings, currentVisibleLength, targetText: 'Motor mount', dtMs: 100 };
    assert.equal(isTypewriterWriting(streaming), true);
    assert.equal(advanceTypewriterProgress(streaming), 7);
    assert.equal(advanceTypewriterProgress({ ...streaming, reducedMotion: true }), 11);
    assert.equal(advanceTypewriterProgress({ ...streaming, targetText: 'Cache' }), 5);
  });
});

function overlaps(left, right) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function anchorsAt(x, y) {
  return {
    center: { x, y },
    left: { x: x - 40, y },
    right: { x: x + 40, y },
    top: { x, y: y - 35 },
    bottom: { x, y: y + 35 },
  };
}

function assertCollisionFree(layout, input) {
  assert.ok(layout.explanation);
  assert.ok(layout.answer);
  const part = input.anchors;
  const partRect = {
    x: part.left.x,
    y: part.top.y,
    width: part.right.x - part.left.x,
    height: part.bottom.y - part.top.y,
  };
  const rectangles = [partRect, input.partLabelRect, layout.explanation.rect, layout.answer.rect];
  for (const [index, rect] of rectangles.entries()) {
    for (const other of rectangles.slice(index + 1)) {
      if (index < 2 && other === input.partLabelRect) continue;
      assert.equal(overlaps(rect, other), false);
    }
  }
  for (const placement of [layout.explanation, layout.answer]) {
    assertWithinInsets(placement, input);
    assertArrowPointsToAnchor(placement);
  }
}

function assertWithinInsets({ rect }, { viewportWidth, viewportHeight }) {
  assert.ok(rect.x >= 16);
  assert.ok(rect.x + rect.width <= viewportWidth - 16);
  assert.ok(rect.y >= (viewportWidth <= 800 ? 122 : 84));
  assert.ok(rect.y + rect.height <= viewportHeight - 112);
}

function assertArrowPointsToAnchor({ anchor, leaderPath, arrowPath }) {
  const leader = leaderPath
    .split(/\s+/)
    .filter((token) => token !== 'M' && token !== 'L')
    .map(Number);
  const arrow = arrowPath
    .split(/\s+/)
    .filter((token) => token !== 'M' && token !== 'L' && token !== 'Z')
    .map(Number);
  assert.equal(leader.length, 6);
  assert.equal(arrow.length, 6);
  assert.ok(arrowPath.endsWith(' Z'));

  const [leaderX, leaderY] = leader.slice(-2);
  const [tipX, tipY, leftX, leftY, rightX, rightY] = arrow;
  assert.ok(Math.abs(leaderX - (leftX + rightX) / 2) < 1e-6);
  assert.ok(Math.abs(leaderY - (leftY + rightY) / 2) < 1e-6);

  const dx = tipX - leaderX;
  const dy = tipY - leaderY;
  const anchorDx = anchor.x - tipX;
  const anchorDy = anchor.y - tipY;
  assert.ok(dx * anchorDx + dy * anchorDy > 0);
  assert.ok(Math.abs(dx * anchorDy - dy * anchorDx) < 1e-6);
}

describe('learning callout layout', () => {
  it('places desktop cards on opposite sides and clears the existing Part label', () => {
    const input = {
      viewportWidth: 1200,
      viewportHeight: 850,
      anchors: anchorsAt(600, 380),
      partLabelRect: { x: 665, y: 265, width: 160, height: 90 },
      explanationSize: { width: 270, height: 106 },
      answerSize: { width: 260, height: 110 },
    };
    const layout = computeLearningCalloutsLayout(input);
    assertCollisionFree(layout, input);
    assert.ok(layout.explanation.rect.x + layout.explanation.rect.width < input.anchors.left.x);
    assert.ok(layout.answer.rect.x > input.anchors.right.x);
    assert.ok(layout.answer.rect.y > input.anchors.center.y);
    assert.deepEqual(layout.explanation.anchor, input.anchors.left);
    assert.deepEqual(layout.answer.anchor, input.anchors.right);
  });

  it('stacks mobile cards without covering the part, HUD, or composer at and below 800px', () => {
    for (const viewportWidth of [390, 800]) {
      const input = {
        viewportWidth,
        viewportHeight: 880,
        anchors: anchorsAt(viewportWidth / 2, 400),
        partLabelRect: { x: viewportWidth / 2 + 54, y: 330, width: 108, height: 64 },
        explanationSize: { width: 245, height: 92 },
        answerSize: { width: 245, height: 120 },
      };
      const layout = computeLearningCalloutsLayout(input);
      assertCollisionFree(layout, input);
      assert.ok(layout.explanation.rect.y + layout.explanation.rect.height < input.anchors.top.y);
      assert.ok(layout.answer.rect.y > input.anchors.bottom.y);
    }
  });

  it('anchors an overview answer with no focused part or Part label', () => {
    const input = {
      viewportWidth: 430,
      viewportHeight: 932,
      anchors: null,
      answerAnchors: anchorsAt(253, 491),
      partLabelRect: null,
      explanationSize: null,
      answerSize: { width: 300, height: 118 },
    };
    const layout = computeLearningCalloutsLayout(input);
    assert.equal(layout.explanation, null);
    assert.ok(layout.answer);
    assert.deepEqual(layout.answer.anchor, input.answerAnchors.bottom);
    assertWithinInsets(layout.answer, input);
    assertArrowPointsToAnchor(layout.answer);
  });

  for (const [viewportWidth, viewportHeight] of [
    [1280, 800],
    [390, 844],
  ]) {
    it(`keeps the overview and answer clear of the HUD and hover label at ${viewportWidth}×${viewportHeight}`, () => {
      const anchors = anchorsAt(viewportWidth / 2, 360);
      const answerAnchors = anchorsAt(viewportWidth / 2 + 30, 398);
      const hud = { x: 16, y: 140, width: viewportWidth - 32, height: 114 };
      const hoverLabel =
        viewportWidth > 800
          ? { x: viewportWidth / 2 - 346, y: 305, width: 230, height: 90 }
          : { x: 116, y: 454, width: 190, height: 48 };
      const input = {
        viewportWidth,
        viewportHeight,
        anchors,
        answerAnchors,
        partLabelRect: null,
        explanationSize: { width: 245, height: 80 },
        answerSize: { width: 245, height: 110 },
      };
      const unobstructed = computeLearningCalloutsLayout(input);
      assert.ok(
        [unobstructed.explanation, unobstructed.answer].some(
          ({ rect }) => overlaps(rect, hoverLabel) || overlaps(rect, hud),
        ),
      );
      const layout = computeLearningCalloutsLayout({ ...input, obstacles: [hud, hoverLabel] });
      assert.ok(layout.explanation);
      assert.ok(layout.answer);
      assert.equal(overlaps(layout.explanation.rect, layout.answer.rect), false);
      const projectedParts = [anchors, answerAnchors].map(({ left, right, top, bottom }) => ({
        x: left.x,
        y: top.y,
        width: right.x - left.x,
        height: bottom.y - top.y,
      }));
      for (const placement of [layout.explanation, layout.answer]) {
        for (const obstacle of [hud, hoverLabel, ...projectedParts]) {
          assert.equal(overlaps(placement.rect, obstacle), false);
        }
        assertWithinInsets(placement, input);
        assertArrowPointsToAnchor(placement);
      }
    });
  }

  it('prioritizes the answer only when both cards need the same space on a tight viewport', () => {
    const input = {
      viewportWidth: 320,
      viewportHeight: 630,
      anchors: anchorsAt(160, 370),
      partLabelRect: null,
      explanationSize: { width: 300, height: 195 },
      answerSize: { width: 300, height: 195 },
    };
    const layout = computeLearningCalloutsLayout(input);
    assert.equal(layout.explanation, null);
    assert.ok(layout.answer);
    assert.equal(layout.answer.rect.width, 288);
    assertWithinInsets(layout.answer, input);

    const explanationOnly = computeLearningCalloutsLayout({ ...input, answerSize: null });
    assert.ok(explanationOnly.explanation);
    assert.equal(explanationOnly.answer, null);
    assertWithinInsets(explanationOnly.explanation, input);
  });
});
