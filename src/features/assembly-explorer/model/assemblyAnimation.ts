import type {
  AssemblyNode,
  ComponentId,
  ExplodeStageFilter,
  Vector3Tuple,
  VerifiedProjectAssembly,
} from '@/shared/domain';

import type { ExplorerCameraState } from '../types';

export type SpringConfig = {
  readonly stiffness: number;
  readonly damping: number;
  readonly restPositionEpsilon: number;
  readonly restVelocityEpsilon: number;
};

export type SpringScalarState = { readonly value: number; readonly velocity: number };

export type AssemblyPlaybackPhase =
  | { readonly kind: 'assembling'; readonly elapsedSec: number; readonly totalDurationSec: number }
  | { readonly kind: 'settled' };

export type NodeAssemblyWindow = {
  readonly nodeId: ComponentId;
  readonly stepOrder: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly approachOffsetMeters: Vector3Tuple;
};

export type AssemblyAnimationTargets = {
  readonly explodeFactor: number;
  readonly activeExplodeStage: ExplodeStageFilter;
  readonly camera: ExplorerCameraState;
  readonly isolatedComponentId: ComponentId | null;
  readonly separatedOffsets: Readonly<Record<string, Vector3Tuple>>;
};

export type AnimatedNodePose = {
  readonly worldPositionMeters: Vector3Tuple;
  readonly localPositionMeters: Vector3Tuple;
  readonly opacity: number;
  readonly scale: number;
  readonly visible: boolean;
  readonly isAnimatingOpacity: boolean;
};

export type AssemblyFrameSnapshot = {
  readonly isActive: boolean;
  readonly geometryChanged: boolean;
  readonly cameraChanged: boolean;
  readonly assemblyStatus: AssemblyPlaybackPhase['kind'];
  readonly assemblyProgress: number;
  readonly animatedExplodeFactor: number;
  readonly animatedCamera: ExplorerCameraState;
  readonly nodePoses: Readonly<Record<string, AnimatedNodePose>>;
};

export type AssemblyAnimationController = {
  readonly schedule: readonly NodeAssemblyWindow[];
  readonly step: (dtSec: number, targets: AssemblyAnimationTargets) => AssemblyFrameSnapshot;
  readonly settlePlayback: () => void;
};

type AnimationNode = Pick<
  AssemblyNode,
  | 'id'
  | 'parentId'
  | 'depth'
  | 'level'
  | 'restPositionMeters'
  | 'explodeDirection'
  | 'explodeDistanceMeters'
>;

type AnimationAssembly = {
  readonly nodes: readonly AnimationNode[];
  readonly assemblySteps: VerifiedProjectAssembly['assemblySteps'];
};

const EXPLODE_SPRING: SpringConfig = {
  stiffness: 170,
  damping: 21,
  restPositionEpsilon: 0.0005,
  restVelocityEpsilon: 0.002,
};
const ZERO: Vector3Tuple = [0, 0, 0];
const POSITION_EPSILON_METERS = 0.00001;
const ANGLE_EPSILON_DEG = 0.01;
const DAMPING_RATE = 14;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(value: number): number {
  const u = clamp01(value);
  return u * u * (3 - 2 * u);
}

function elapsedSeconds(dtSec: number): number {
  return Number.isFinite(dtSec) ? Math.max(0, dtSec) : 0;
}

export function stepSpringScalar(
  state: SpringScalarState,
  target: number,
  dtSec: number,
  config: SpringConfig = EXPLODE_SPRING,
): SpringScalarState {
  const dt = Math.min(elapsedSeconds(dtSec), 0.05);
  const steps = Math.ceil(dt / 0.008);
  const h = steps > 0 ? dt / steps : 0;
  let { value, velocity } = state;

  for (let i = 0; i < steps; i += 1) {
    const acceleration = config.stiffness * (target - value) - config.damping * velocity;
    const midValue = value + (h / 2) * velocity;
    const midVelocity = velocity + (h / 2) * acceleration;
    value += h * midVelocity;
    velocity += h * (config.stiffness * (target - midValue) - config.damping * midVelocity);
  }

  if (
    Math.abs(target - value) <= config.restPositionEpsilon &&
    Math.abs(velocity) <= config.restVelocityEpsilon
  ) {
    return { value: target, velocity: 0 };
  }
  return { value, velocity };
}

function scaleVector(vector: Vector3Tuple, factor: number): Vector3Tuple {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor];
}

function approachOffset(node: AnimationNode): Vector3Tuple {
  const direction =
    Math.hypot(...node.explodeDirection) < 0.00001
      ? ([0, 1, 0] satisfies Vector3Tuple)
      : node.explodeDirection;
  return scaleVector(direction, Math.max(node.explodeDistanceMeters * 1.45, 0.035));
}

export function buildAssemblySchedule(assembly: AnimationAssembly): readonly NodeAssemblyWindow[] {
  const parentIds = new Set(assembly.nodes.map((node) => node.parentId));
  const remainingParts = new Map(
    assembly.nodes
      .filter(
        (node) =>
          node.level === 'component' || node.level === 'subcomponent' || !parentIds.has(node.id),
      )
      .map((node) => [node.id, node]),
  );
  const groups: { readonly order: number; readonly parts: readonly AnimationNode[] }[] = [];

  for (const step of [...assembly.assemblySteps].sort((a, b) => a.order - b.order)) {
    const parts: AnimationNode[] = [];
    for (const id of step.componentIds) {
      const part = remainingParts.get(id);
      if (part !== undefined) {
        parts.push(part);
        remainingParts.delete(id);
      }
    }
    if (parts.length > 0) {
      groups.push({ order: step.order, parts });
    }
  }

  const fallbackByDepth = new Map<number, AnimationNode[]>();
  for (const node of remainingParts.values()) {
    const parts = fallbackByDepth.get(node.depth) ?? [];
    parts.push(node);
    fallbackByDepth.set(node.depth, parts);
  }
  const lastOrder = groups.at(-1)?.order ?? 0;
  for (const [index, [, parts]] of [...fallbackByDepth].sort(([a], [b]) => a - b).entries()) {
    groups.push({ order: lastOrder + index + 1, parts });
  }

  const partCount = groups.reduce((count, { parts }) => count + parts.length, 0);
  const totalSec = Math.min(3.1, Math.max(2.1, 1.1 + groups.length * 0.24 + partCount * 0.039));
  const stepDuration = totalSec / (1 + (groups.length - 1) * 0.8);
  return groups.flatMap(({ order, parts }, stepIndex) => {
    const stepStart = stepIndex * stepDuration * 0.8;
    const stagger = parts.length > 1 ? 0.32 * stepDuration : 0;
    return parts.map((part, partIndex) => {
      const startSec = stepStart + (stagger * partIndex) / Math.max(1, parts.length - 1);
      return {
        nodeId: part.id,
        stepOrder: order,
        startSec,
        endSec: startSec + stepDuration - stagger,
        approachOffsetMeters: approachOffset(part),
      };
    });
  });
}

function damp(value: number, target: number, alpha: number, epsilon: number): number {
  const next = value + (target - value) * alpha;
  return Math.abs(target - next) <= epsilon ? target : next;
}

function dampVector(value: Vector3Tuple, target: Vector3Tuple, alpha: number): Vector3Tuple {
  const x = damp(value[0], target[0], alpha, POSITION_EPSILON_METERS);
  const y = damp(value[1], target[1], alpha, POSITION_EPSILON_METERS);
  const z = damp(value[2], target[2], alpha, POSITION_EPSILON_METERS);
  return x === value[0] && y === value[1] && z === value[2] ? value : [x, y, z];
}

function dampCamera(
  camera: ExplorerCameraState,
  target: ExplorerCameraState,
  alpha: number,
): ExplorerCameraState {
  const shortestAzimuthDelta =
    ((((target.azimuthDeg - camera.azimuthDeg + 180) % 360) + 360) % 360) - 180;
  const wrappedTarget = camera.azimuthDeg + shortestAzimuthDelta;
  const azimuth = damp(camera.azimuthDeg, wrappedTarget, alpha, ANGLE_EPSILON_DEG);
  return {
    azimuthDeg: azimuth === wrappedTarget ? target.azimuthDeg : azimuth,
    elevationDeg: damp(camera.elevationDeg, target.elevationDeg, alpha, ANGLE_EPSILON_DEG),
    distanceMeters: damp(
      camera.distanceMeters,
      target.distanceMeters,
      alpha,
      POSITION_EPSILON_METERS,
    ),
    targetMeters: dampVector(camera.targetMeters, target.targetMeters, alpha),
  };
}

function vectorsEqual(a: Vector3Tuple, b: Vector3Tuple): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function camerasEqual(a: ExplorerCameraState, b: ExplorerCameraState): boolean {
  return (
    a.azimuthDeg === b.azimuthDeg &&
    a.elevationDeg === b.elevationDeg &&
    a.distanceMeters === b.distanceMeters &&
    vectorsEqual(a.targetMeters, b.targetMeters)
  );
}

function stageMultipliers(stage: ExplodeStageFilter): Vector3Tuple {
  return [1, stage === 1 ? 0 : 1, stage === 1 || stage === 2 ? 0 : 1];
}

function explodeWeights(factor: number, multipliers: Vector3Tuple): Vector3Tuple {
  const overshoot = 0.02 * smoothstep((factor - 1) / 0.03);
  return [
    (smoothstep(factor / 0.45) + overshoot) * multipliers[0],
    (smoothstep((factor - 0.15) / 0.55) + overshoot) * multipliers[1],
    (smoothstep((factor - 0.4) / 0.6) + overshoot) * multipliers[2],
  ];
}

function getAncestorChain(node: AnimationNode, nodesById: ReadonlyMap<ComponentId, AnimationNode>) {
  const chain: AnimationNode[] = [];
  const visited = new Set<ComponentId>();
  let current: AnimationNode | undefined = node;
  while (current !== undefined && !visited.has(current.id)) {
    chain.push(current);
    visited.add(current.id);
    current = current.parentId === null ? undefined : nodesById.get(current.parentId);
  }
  return chain;
}

function computeWorldPosition(
  node: AnimationNode,
  chain: readonly AnimationNode[],
  weights: Vector3Tuple,
  offsets: ReadonlyMap<ComponentId, Vector3Tuple>,
  approach: Vector3Tuple,
): Vector3Tuple {
  let [x, y, z] = node.restPositionMeters;
  for (const ancestor of chain) {
    const weight =
      ancestor.depth <= 0
        ? 0
        : ancestor.depth === 1
          ? weights[0]
          : ancestor.depth === 2
            ? weights[1]
            : weights[2];
    const distance = weight * ancestor.explodeDistanceMeters;
    const [dx, dy, dz] = ancestor.explodeDirection;
    const [sx, sy, sz] = offsets.get(ancestor.id) ?? ZERO;
    x += dx * distance + sx;
    y += dy * distance + sy;
    z += dz * distance + sz;
  }
  return [x + approach[0], y + approach[1], z + approach[2]];
}

function partArrival(window: NodeAssemblyWindow | undefined, phase: AssemblyPlaybackPhase) {
  if (window === undefined || phase.kind === 'settled' || phase.elapsedSec >= window.endSec) {
    return { approach: ZERO, opacity: 1, scale: 1 };
  }
  const u = clamp01((phase.elapsedSec - window.startSec) / (window.endSec - window.startSec));
  const remaining = 1 - u;
  const approachWeight = remaining * remaining * (1.48 * remaining - 0.48);
  return {
    approach: scaleVector(window.approachOffsetMeters, approachWeight),
    opacity: smoothstep(u / 0.35),
    scale: 0.94 + 0.06 * smoothstep(u / 0.55),
  };
}

export function createAssemblyAnimationController({
  assembly,
  targets: initialTargets,
  prefersReducedMotion = false,
}: {
  readonly assembly: AnimationAssembly;
  readonly targets: AssemblyAnimationTargets;
  readonly prefersReducedMotion?: boolean;
}): AssemblyAnimationController {
  const schedule = buildAssemblySchedule(assembly);
  const windowsById = new Map(schedule.map((window) => [window.nodeId, window]));
  const nodesById = new Map(assembly.nodes.map((node) => [node.id, node]));
  const nodes = assembly.nodes.map((node) => ({ node, chain: getAncestorChain(node, nodesById) }));
  const totalDurationSec = schedule.at(-1)?.endSec ?? 0;
  let phase: AssemblyPlaybackPhase =
    prefersReducedMotion || totalDurationSec === 0
      ? { kind: 'settled' }
      : { kind: 'assembling', elapsedSec: 0, totalDurationSec };
  let previousPhase: AssemblyPlaybackPhase | undefined;
  let spring: SpringScalarState = { value: initialTargets.explodeFactor, velocity: 0 };
  let multipliers = stageMultipliers(initialTargets.activeExplodeStage);
  let previousWeights: Vector3Tuple = ZERO;
  let previousIsolation: ComponentId | null = null;
  const liveOffsets = new Map<ComponentId, Vector3Tuple>();
  let camera = initialTargets.camera;
  let nodePoses: AssemblyFrameSnapshot['nodePoses'] = {};

  return {
    schedule,
    settlePlayback() {
      phase = { kind: 'settled' };
    },
    step(dtSec, targets) {
      const elapsedDelta = elapsedSeconds(dtSec);
      const alpha = prefersReducedMotion
        ? 1
        : 1 - Math.exp(-DAMPING_RATE * Math.min(elapsedDelta, 0.05));
      if (phase.kind === 'assembling' && elapsedDelta > 0) {
        const elapsedSec = phase.elapsedSec + elapsedDelta;
        phase =
          elapsedSec < phase.totalDurationSec ? { ...phase, elapsedSec } : { kind: 'settled' };
      }

      spring = prefersReducedMotion
        ? { value: targets.explodeFactor, velocity: 0 }
        : stepSpringScalar(spring, targets.explodeFactor, elapsedDelta);
      const targetMultipliers = stageMultipliers(targets.activeExplodeStage);
      multipliers = dampVector(multipliers, targetMultipliers, alpha);
      const weights = explodeWeights(spring.value, multipliers);
      let offsetsChanged = false;
      let offsetsMoving = false;
      for (const { node } of nodes) {
        const offset = liveOffsets.get(node.id) ?? ZERO;
        const target = targets.separatedOffsets[node.id] ?? ZERO;
        if (vectorsEqual(offset, target)) continue;
        const next = dampVector(offset, target, alpha);
        if (vectorsEqual(next, ZERO)) liveOffsets.delete(node.id);
        else liveOffsets.set(node.id, next);
        offsetsChanged ||= next !== offset;
        offsetsMoving ||= !vectorsEqual(next, target);
      }

      let geometryChanged = false;
      if (
        phase !== previousPhase ||
        !vectorsEqual(weights, previousWeights) ||
        offsetsChanged ||
        targets.isolatedComponentId !== previousIsolation
      ) {
        const worldPoses: Record<string, Omit<AnimatedNodePose, 'localPositionMeters'>> = {};
        for (const { node, chain } of nodes) {
          const { approach, opacity, scale } = partArrival(windowsById.get(node.id), phase);
          worldPoses[node.id] = {
            worldPositionMeters: computeWorldPosition(node, chain, weights, liveOffsets, approach),
            opacity,
            scale,
            visible:
              opacity > 0 &&
              (targets.isolatedComponentId === null || targets.isolatedComponentId === node.id),
            isAnimatingOpacity: opacity < 0.999,
          };
        }
        const nextPoses: Record<string, AnimatedNodePose> = {};
        for (const { node } of nodes) {
          const pose = worldPoses[node.id];
          if (pose === undefined) continue;
          const [x, y, z] = pose.worldPositionMeters;
          const [px, py, pz] =
            node.parentId === null
              ? ZERO
              : (worldPoses[node.parentId]?.worldPositionMeters ?? ZERO);
          const previous = nodePoses[node.id];
          geometryChanged ||=
            previous?.visible !== pose.visible ||
            (pose.visible &&
              (previous.opacity !== pose.opacity ||
                previous.scale !== pose.scale ||
                !vectorsEqual(previous.worldPositionMeters, pose.worldPositionMeters)));
          nextPoses[node.id] = { ...pose, localPositionMeters: [x - px, y - py, z - pz] };
        }
        nodePoses = nextPoses;
        previousPhase = phase;
        previousWeights = weights;
        previousIsolation = targets.isolatedComponentId;
      }

      const isolated =
        targets.isolatedComponentId === null ? undefined : nodePoses[targets.isolatedComponentId];
      const cameraTarget =
        isolated === undefined
          ? targets.camera
          : { ...targets.camera, targetMeters: isolated.worldPositionMeters };
      const nextCamera = dampCamera(camera, cameraTarget, alpha);
      const cameraChanged = !camerasEqual(camera, nextCamera);
      camera = nextCamera;

      return {
        isActive:
          phase.kind === 'assembling' ||
          spring.value !== targets.explodeFactor ||
          spring.velocity !== 0 ||
          !vectorsEqual(multipliers, targetMultipliers) ||
          offsetsMoving ||
          !camerasEqual(camera, cameraTarget),
        geometryChanged,
        cameraChanged,
        assemblyStatus: phase.kind,
        assemblyProgress: phase.kind === 'settled' ? 1 : phase.elapsedSec / phase.totalDurationSec,
        animatedExplodeFactor: spring.value,
        animatedCamera: camera,
        nodePoses,
      };
    },
  };
}

export function settleAssemblyPlayback(controller: AssemblyAnimationController): void {
  controller.settlePlayback();
}
