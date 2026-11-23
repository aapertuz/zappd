import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getCatalogArchetypeById } from '../../../shared/domain/catalog.ts';
import {
  buildAssemblySchedule,
  createAssemblyAnimationController,
  settleAssemblyPlayback,
  stepSpringScalar,
} from '../model/assemblyAnimation.ts';
import { DEFAULT_EXPLORER_CAMERA } from '../model/explorerState.ts';

const TARGETS = {
  explodeFactor: 0,
  activeExplodeStage: 'all',
  camera: DEFAULT_EXPLORER_CAMERA,
  isolatedComponentId: null,
  separatedOffsets: {},
};

function getCatalogAssembly(archetypeId) {
  const assembly = getCatalogArchetypeById(archetypeId);
  assert.ok(assembly);
  return assembly;
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function finishAnimation(controller, targets, dtSec = 1 / 60) {
  for (let frame = 0; frame < 300; frame += 1) {
    const snapshot = controller.step(dtSec, targets);
    if (!snapshot.isActive) return snapshot;
  }
  assert.fail('Animation did not settle');
}

describe('assembly playback', () => {
  for (const [id, partCount, expectedDuration] of [
    ['open_source_rover_v1', 11, 2.2],
    ['robotic_arm_3dof_v1', 19, 2.8],
    ['quadcopter_drone_v1', 26, 3.0],
  ]) {
    it(`schedules all ${partCount} CAD parts in instruction order for ${id}`, () => {
      const assembly = getCatalogAssembly(id);
      const steps = [...assembly.assemblySteps].sort((a, b) => a.order - b.order);
      const schedule = buildAssemblySchedule({ ...assembly, assemblySteps: [...steps].reverse() });
      const cadParts = assembly.nodes.filter(({ level }) =>
        ['component', 'subcomponent'].includes(level),
      );
      assert.equal(schedule.length, partCount);
      assert.deepEqual(
        new Set(schedule.map(({ nodeId }) => nodeId)),
        new Set(cadParts.map(({ id }) => id)),
      );
      assert.deepEqual(
        schedule.map(({ nodeId, stepOrder }) => [nodeId, stepOrder]),
        steps.flatMap(({ order, componentIds }) => componentIds.map((nodeId) => [nodeId, order])),
      );
      assert.ok(
        schedule.every(({ approachOffsetMeters }) => Math.hypot(...approachOffsetMeters) > 0),
      );
      assert.ok(Math.abs(schedule.at(-1).endSec - expectedDuration) <= 0.1);

      for (const step of steps.slice(1)) {
        const previous = schedule.filter(({ stepOrder }) => stepOrder === step.order - 1);
        const current = schedule.filter(({ stepOrder }) => stepOrder === step.order);
        assert.ok(current[0].startSec < previous.at(-1).endSec);
      }
    });

    it(`seats each part at rest as ${id} assembles`, () => {
      const assembly = getCatalogAssembly(id);
      const controller = createAssemblyAnimationController({ assembly, targets: TARGETS });
      const { schedule } = controller;
      const first = schedule[0];
      const last = schedule.at(-1);
      const initial = controller.step(0, TARGETS);
      assert.equal(initial.assemblyStatus, 'assembling');
      assert.equal(initial.assemblyProgress, 0);
      for (const { nodeId } of schedule) {
        const pose = initial.nodePoses[nodeId];
        assert.equal(pose.visible, false);
        assert.equal(pose.opacity, 0);
      }

      const shortlyAfterStart = controller.step(0.1 * (first.endSec - first.startSec), TARGETS);
      const arriving = shortlyAfterStart.nodePoses[first.nodeId];
      assert.equal(arriving.visible, true);
      assert.equal(arriving.isAnimatingOpacity, true);
      assert.ok(arriving.opacity > 0 && arriving.opacity < 1);
      assert.ok(arriving.scale > 0.94 && arriving.scale < 1);

      const partlyAssembled = controller.step(last.endSec * 0.5, TARGETS);
      const firstNode = assembly.nodes.find(({ id }) => id === first.nodeId);
      assert.equal(partlyAssembled.nodePoses[first.nodeId].opacity, 1);
      assert.deepEqual(
        partlyAssembled.nodePoses[first.nodeId].worldPositionMeters,
        firstNode.restPositionMeters,
      );
      assert.equal(partlyAssembled.nodePoses[last.nodeId].visible, false);

      const settled = finishAnimation(controller, TARGETS, 1 / 12);
      assert.equal(settled.assemblyStatus, 'settled');
      assert.equal(settled.assemblyProgress, 1);
      assert.equal(settled.isActive, false);
      for (const node of assembly.nodes) {
        const pose = settled.nodePoses[node.id];
        assert.ok(distance(pose.worldPositionMeters, node.restPositionMeters) <= 1e-5);
        assert.equal(pose.opacity, 1);
        assert.equal(pose.scale, 1);
        assert.equal(pose.visible, true);
        assert.equal(pose.isAnimatingOpacity, false);
        if (node.parentId !== null) {
          const { worldPositionMeters: parent } = settled.nodePoses[node.parentId];
          assert.deepEqual(
            pose.localPositionMeters,
            node.restPositionMeters.map((x, i) => x - parent[i]),
          );
        }
      }
      assert.equal(controller.step(1 / 60, TARGETS).geometryChanged, false);
    });
  }

  it('uses the earliest listed step and schedules unlisted parts by depth', () => {
    const assembly = getCatalogAssembly('open_source_rover_v1');
    const first = assembly.assemblySteps[0];
    const onlyListed = first.componentIds[0];
    const schedule = buildAssemblySchedule({
      ...assembly,
      assemblySteps: [
        { ...first, order: 5, componentIds: [onlyListed, onlyListed] },
        { ...first, order: 6, componentIds: [onlyListed] },
      ],
      nodes: assembly.nodes.map((node) =>
        node.id === onlyListed
          ? { ...node, explodeDirection: [0, 0, 0], explodeDistanceMeters: 0 }
          : node,
      ),
    });
    assert.equal(schedule.filter(({ nodeId }) => nodeId === onlyListed).length, 1);
    assert.deepEqual(schedule[0].approachOffsetMeters, [0, 0.035, 0]);
    const unlistedDepths = schedule
      .slice(1)
      .map(({ nodeId }) => assembly.nodes.find(({ id }) => id === nodeId).depth);
    assert.deepEqual(
      unlistedDepths,
      [...unlistedDepths].sort((a, b) => a - b),
    );
  });

  it('seats all parts immediately when playback is interrupted', () => {
    const assembly = getCatalogAssembly('open_source_rover_v1');
    const controller = createAssemblyAnimationController({ assembly, targets: TARGETS });
    assert.equal(controller.step(0.5, TARGETS).assemblyStatus, 'assembling');
    settleAssemblyPlayback(controller);
    const frame = controller.step(0, TARGETS);
    assert.equal(frame.assemblyStatus, 'settled');
    assert.equal(frame.isActive, false);
    for (const node of assembly.nodes) {
      assert.deepEqual(frame.nodePoses[node.id].worldPositionMeters, node.restPositionMeters);
      assert.equal(frame.nodePoses[node.id].opacity, 1);
    }
  });
});

describe('assembly pose transitions', () => {
  const assembly = getCatalogAssembly('quadcopter_drone_v1');

  it('eases to the explode target with a small overshoot and exact rest', () => {
    const controller = createAssemblyAnimationController({ assembly, targets: TARGETS });
    settleAssemblyPlayback(controller);
    const targets = { ...TARGETS, explodeFactor: 1 };
    const frames = Array.from({ length: 60 }, (_, i) =>
      controller.step(i === 7 ? 0.5 : 1 / 60, targets),
    );
    const values = frames.map(({ animatedExplodeFactor }) => animatedExplodeFactor);
    const peak = Math.max(...values);
    const beforePeak = values.slice(0, values.indexOf(peak) + 1);
    assert.ok(beforePeak.length > 5);
    assert.ok(beforePeak.every((value, i) => i === 0 || value > beforePeak[i - 1]));
    assert.ok(peak > 1.01 && peak <= 1.05);
    assert.equal(values.at(-1), 1);
    assert.equal(frames.at(-1).isActive, false);
    assert.equal(frames.at(-1).geometryChanged, false);
  });

  it('clamps frame spikes and converges at low and high frame rates', () => {
    const initial = { value: 0, velocity: 0 };
    assert.deepEqual(stepSpringScalar(initial, 1, 0.5), stepSpringScalar(initial, 1, 0.05));
    assert.deepEqual(stepSpringScalar(initial, 1, -0.5), initial);
    for (const hz of [12, 60, 144]) {
      let spring = initial;
      let peak = 0;
      for (let i = 0; i < hz * 2; i += 1) {
        spring = stepSpringScalar(spring, 1, 1 / hz);
        assert.ok(Number.isFinite(spring.value) && Number.isFinite(spring.velocity));
        peak = Math.max(peak, spring.value);
      }
      assert.ok(peak > 1 && peak <= 1.05);
      assert.deepEqual(spring, { value: 1, velocity: 0 });
    }
  });

  it('blends positions across every stage change while honoring the depth filter', () => {
    const target = { ...TARGETS, explodeFactor: 1 };
    const controller = createAssemblyAnimationController({ assembly, targets: target });
    settleAssemblyPlayback(controller);
    const fullyExploded = controller.step(0, target);
    const part = assembly.nodes.find(({ id }) => id === 'comp_arm_fl');
    const subpart = assembly.nodes.find(({ id }) => id === 'subcomp_prop_fl');
    let previous = fullyExploded;
    for (const [stage, node] of [
      [1, part],
      [2, part],
      [3, subpart],
    ]) {
      const targets = { ...target, activeExplodeStage: stage };
      const first = controller.step(1 / 60, targets);
      const second = controller.step(1 / 60, targets);
      const settled = finishAnimation(controller, targets);
      const endPosition = settled.nodePoses[node.id].worldPositionMeters;
      const positionBefore = previous.nodePoses[node.id].worldPositionMeters;
      const firstPosition = first.nodePoses[node.id].worldPositionMeters;
      const secondPosition = second.nodePoses[node.id].worldPositionMeters;
      assert.ok(first.isActive);
      assert.ok(distance(firstPosition, endPosition) < distance(positionBefore, endPosition));
      assert.ok(distance(secondPosition, endPosition) < distance(firstPosition, endPosition));
      if (stage === 1) {
        assert.deepEqual(endPosition, part.restPositionMeters);
      } else {
        assert.deepEqual(endPosition, fullyExploded.nodePoses[node.id].worldPositionMeters);
      }
      previous = settled;
    }
  });

  it('orbits via the shortest angle and keeps geometry still during camera-only frames', () => {
    const initial = { ...TARGETS, camera: { ...TARGETS.camera, azimuthDeg: 358 } };
    const controller = createAssemblyAnimationController({ assembly, targets: initial });
    const camera = { ...initial.camera, azimuthDeg: 2, elevationDeg: 33, distanceMeters: 0.2 };
    const whileAssembling = controller.step(1 / 60, { ...initial, camera });
    assert.equal(whileAssembling.assemblyStatus, 'assembling');
    assert.ok(whileAssembling.animatedCamera.azimuthDeg > 358);
    settleAssemblyPlayback(controller);
    controller.step(0, initial);
    const next = controller.step(1 / 60, { ...initial, camera });
    assert.equal(next.geometryChanged, false);
    assert.equal(next.cameraChanged, true);
    assert.deepEqual(finishAnimation(controller, { ...initial, camera }).animatedCamera, camera);
  });

  it('damps separation, the isolation target and part reset', () => {
    const controller = createAssemblyAnimationController({ assembly, targets: TARGETS });
    settleAssemblyPlayback(controller);
    const node = assembly.nodes.find(({ id }) => id === 'comp_arm_fl');
    const targets = {
      ...TARGETS,
      isolatedComponentId: node.id,
      separatedOffsets: { [node.id]: [0.04, 0, 0] },
    };
    const [x, y, z] = node.restPositionMeters;
    const first = controller.step(1 / 60, targets);
    assert.ok(first.nodePoses[node.id].worldPositionMeters[0] > x);
    assert.ok(first.nodePoses[node.id].worldPositionMeters[0] < x + 0.04);
    assert.notDeepEqual(first.animatedCamera.targetMeters, [x + 0.04, y, z]);
    const settled = finishAnimation(controller, targets);
    assert.deepEqual(settled.nodePoses[node.id].worldPositionMeters, [x + 0.04, y, z]);
    assert.deepEqual(settled.animatedCamera.targetMeters, [x + 0.04, y, z]);
    const reset = controller.step(1 / 60, { ...targets, separatedOffsets: {} });
    assert.ok(reset.nodePoses[node.id].worldPositionMeters[0] > x);
    assert.ok(reset.nodePoses[node.id].worldPositionMeters[0] < x + 0.04);
    assert.deepEqual(
      finishAnimation(controller, TARGETS).nodePoses[node.id].worldPositionMeters,
      node.restPositionMeters,
    );
  });

  it('starts seated and snaps to all targets in reduced motion', () => {
    const controller = createAssemblyAnimationController({
      assembly,
      targets: TARGETS,
      prefersReducedMotion: true,
    });
    const initial = controller.step(0, TARGETS);
    assert.equal(initial.isActive, false);
    assert.equal(initial.assemblyStatus, 'settled');
    assert.equal(initial.assemblyProgress, 1);
    const node = assembly.nodes.find(({ id }) => id === 'comp_arm_fl');
    const snapshot = controller.step(0, {
      ...TARGETS,
      explodeFactor: 1,
      activeExplodeStage: 1,
      isolatedComponentId: node.id,
      separatedOffsets: { [node.id]: [0.04, 0, 0] },
      camera: { ...TARGETS.camera, azimuthDeg: 0 },
    });
    const [x, y, z] = node.restPositionMeters;
    assert.equal(snapshot.animatedExplodeFactor, 1);
    assert.equal(snapshot.animatedCamera.azimuthDeg, 0);
    assert.deepEqual(snapshot.animatedCamera.targetMeters, [x + 0.04, y, z]);
    assert.deepEqual(snapshot.nodePoses[node.id].worldPositionMeters, [x + 0.04, y, z]);
    assert.equal(snapshot.nodePoses.comp_arm_fr.visible, false);
    assert.equal(snapshot.isActive, false);
  });
});
