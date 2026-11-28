import { type AiProviderId } from '@/shared/domain/aiProvider';
import {
  type AssemblyNode,
  type ComponentId,
  type ExplodeStageFilter,
  type Vector3Tuple,
  type VerifiedProjectAssembly,
  computeNodeWorldPositionMeters,
  isRelationshipId,
} from '@/shared/domain/assembly';

import type {
  AssemblyExplorerAction,
  AssemblyExplorerState,
  DismissedInspectionWarnings,
  ExplorerCameraState,
  SeparationAxis,
  ShellVisibilityMode,
  WiringVisibilityMode,
} from '../types';
import { extrinsicXyzRotationRows } from './restRotation';

export const DEFAULT_EXPLODE_PRESET = 0.65;

export const DEFAULT_EXPLORER_CAMERA: ExplorerCameraState = {
  azimuthDeg: 38,
  elevationDeg: 26,
  distanceMeters: 0.38,
  targetMeters: [0, 0.018, 0],
};

export type AssemblyBoundingBoxMeters = {
  readonly min: Vector3Tuple;
  readonly max: Vector3Tuple;
  readonly center: Vector3Tuple;
  readonly size: Vector3Tuple;
};

const AXES = [0, 1, 2] as const;
const MIN_HALF_EXTENT_METERS = 0.0005;
const DESKTOP_V_HALF_TAN = Math.tan(Math.PI / 9);
const MOBILE_H_HALF_TAN = Math.tan((17 * Math.PI) / 180);
const MOBILE_V_HALF_TAN = MOBILE_H_HALF_TAN / (390 / 844);
const DEFAULT_ZOOM_LIMITS = { minDistanceMeters: 0.08, maxDistanceMeters: 1.8 };
const NEXT_WIRING_VISIBILITY: Readonly<Record<WiringVisibilityMode, WiringVisibilityMode>> = {
  auto: 'show',
  show: 'hide',
  hide: 'auto',
};
const NEXT_SHELL_VISIBILITY: Readonly<Record<ShellVisibilityMode, ShellVisibilityMode>> = {
  solid: 'xray',
  xray: 'hidden',
  hidden: 'solid',
};

function halfExtentMeters(dimensionMm: number): number {
  return Math.max(dimensionMm / 2000, MIN_HALF_EXTENT_METERS);
}

export function computeAssemblyBoundingBoxMeters(
  assembly: VerifiedProjectAssembly,
): AssemblyBoundingBoxMeters {
  const parents = new Set(assembly.nodes.map(({ parentId }) => parentId));
  const leaves = assembly.nodes.filter(
    ({ id, level }) => !parents.has(id) && (level === 'component' || level === 'subcomponent'),
  );
  const nonRootNodes = assembly.nodes.filter(({ id }) => id !== assembly.rootNodeId);
  const physicalNodes =
    leaves.length > 0 ? leaves : nonRootNodes.length > 0 ? nonRootNodes : assembly.nodes;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const { restPositionMeters, restRotationDeg, dimensionsMm } of physicalNodes) {
    const rotation =
      restRotationDeg === undefined ? undefined : extrinsicXyzRotationRows(restRotationDeg);
    for (const axis of AXES) {
      const row = rotation?.[axis];
      const halfExtent =
        row === undefined
          ? halfExtentMeters(dimensionsMm[axis])
          : AXES.reduce<number>(
              (extent, index) =>
                extent + Math.abs(row[index]) * halfExtentMeters(dimensionsMm[index]),
              0,
            );
      min[axis] = Math.min(min[axis], restPositionMeters[axis] - halfExtent);
      max[axis] = Math.max(max[axis], restPositionMeters[axis] + halfExtent);
    }
  }
  if (physicalNodes.length === 0) {
    min.fill(-MIN_HALF_EXTENT_METERS);
    max.fill(MIN_HALF_EXTENT_METERS);
  }
  return {
    min,
    max,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

function computeFrustumDistance(
  halfExtents: Vector3Tuple,
  azimuthDeg: number,
  elevationDeg: number,
  desktopFill: number,
  minimumDistance: number,
): number {
  const azimuth = (azimuthDeg * Math.PI) / 180;
  const elevation = (elevationDeg * Math.PI) / 180;
  const sinAz = Math.sin(azimuth);
  const cosAz = Math.cos(azimuth);
  const sinEl = Math.sin(elevation);
  const cosEl = Math.cos(elevation);
  const [halfX, halfY, halfZ] = halfExtents;
  let distance = minimumDistance;
  for (const x of [-halfX, halfX]) {
    for (const y of [-halfY, halfY]) {
      for (const z of [-halfZ, halfZ]) {
        const horizontalDepth = x * sinAz + z * cosAz;
        const right = Math.abs(x * cosAz - z * sinAz);
        const up = Math.abs(y * cosEl - horizontalDepth * sinEl);
        const towardCamera = horizontalDepth * cosEl + y * sinEl;
        distance = Math.max(
          distance,
          towardCamera + right / (desktopFill * DESKTOP_V_HALF_TAN * 1.6),
          towardCamera + up / (desktopFill * DESKTOP_V_HALF_TAN),
          towardCamera + right / (0.72 * MOBILE_H_HALF_TAN),
          towardCamera + up / (0.5 * MOBILE_V_HALF_TAN),
        );
      }
    }
  }
  return distance;
}

export function computeFramedCameraForBoundingBox(
  { center, size: [x, y, z] }: AssemblyBoundingBoxMeters,
  {
    azimuthDeg,
    elevationDeg,
  }: Pick<ExplorerCameraState, 'azimuthDeg' | 'elevationDeg'> = DEFAULT_EXPLORER_CAMERA,
): ExplorerCameraState {
  return {
    azimuthDeg,
    elevationDeg,
    distanceMeters: computeFrustumDistance(
      [x / 2, y / 2, z / 2],
      azimuthDeg,
      elevationDeg,
      0.5,
      0.03,
    ),
    targetMeters: center,
  };
}

export function computeDefaultCameraForAssembly(
  assembly: VerifiedProjectAssembly | null,
): ExplorerCameraState {
  return assembly === null
    ? DEFAULT_EXPLORER_CAMERA
    : computeFramedCameraForBoundingBox(computeAssemblyBoundingBoxMeters(assembly));
}

const INITIAL_EXPLORER_PROVIDER: AiProviderId = 'deepseek';

export const INITIAL_DISMISSED_WARNINGS: DismissedInspectionWarnings = {
  unverified: false,
  partial_inspection: false,
};

export const INITIAL_ASSEMBLY_EXPLORER_STATE: AssemblyExplorerState = {
  selectedProvider: INITIAL_EXPLORER_PROVIDER,
  lastRequestId: null,
  assembly: null,
  glbArrayBuffer: null,
  isLoading: false,
  loadingPhase: 'idle',
  loadingProgress: 0,
  errorMessage: null,
  parameterRequestId: null,
  isRebuildingParameters: false,
  parameterErrorMessage: null,
  camera: DEFAULT_EXPLORER_CAMERA,
  viewMode: { kind: 'overview' },
  explodeFactor: 0,
  activeExplodeStage: 'all',
  wiringVisibility: 'auto',
  shellVisibility: 'solid',
  selectedComponentId: null,
  isolatedComponentId: null,
  separatedOffsets: {},
  dismissedWarnings: INITIAL_DISMISSED_WARNINGS,
};

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value <= min) {
    return min;
  }
  if (value >= max) {
    return max;
  }
  return value;
}

function addAxisDelta(
  current: Vector3Tuple | undefined,
  axis: SeparationAxis,
  deltaMeters: number,
): Vector3Tuple {
  const base = current ?? [0, 0, 0];
  switch (axis) {
    case 'x':
      return [base[0] + deltaMeters, base[1], base[2]];
    case 'y':
      return [base[0], base[1] + deltaMeters, base[2]];
    case 'z':
      return [base[0], base[1], base[2] + deltaMeters];
  }
}

export function orbitExplorerCamera(
  camera: ExplorerCameraState,
  deltaAzimuthDeg: number,
  deltaElevationDeg: number,
): ExplorerCameraState {
  return {
    ...camera,
    azimuthDeg: (((camera.azimuthDeg + deltaAzimuthDeg) % 360) + 360) % 360,
    elevationDeg: clampNumber(camera.elevationDeg + deltaElevationDeg, -80, 85),
  };
}

export function zoomExplorerCamera(
  camera: ExplorerCameraState,
  deltaDistanceMeters: number,
  {
    minDistanceMeters = DEFAULT_ZOOM_LIMITS.minDistanceMeters,
    maxDistanceMeters = DEFAULT_ZOOM_LIMITS.maxDistanceMeters,
  }: { readonly minDistanceMeters?: number; readonly maxDistanceMeters?: number } = {},
): ExplorerCameraState {
  return {
    ...camera,
    distanceMeters: clampNumber(
      camera.distanceMeters + deltaDistanceMeters,
      minDistanceMeters,
      maxDistanceMeters,
    ),
  };
}

export function computeCameraZoomLimits(assembly: VerifiedProjectAssembly | null) {
  if (assembly === null) return DEFAULT_ZOOM_LIMITS;
  const bounds = computeAssemblyBoundingBoxMeters(assembly);
  return {
    minDistanceMeters: Math.min(
      DEFAULT_ZOOM_LIMITS.minDistanceMeters,
      Math.max(...bounds.size) * 0.15,
    ),
    maxDistanceMeters: Math.max(
      DEFAULT_ZOOM_LIMITS.maxDistanceMeters,
      computeFramedCameraForBoundingBox(bounds).distanceMeters * 3.5,
    ),
  };
}

export function reconcileCameraTarget({
  previousStateCamera,
  stateCamera,
  liveCamera,
  lastCommittedCamera,
  modelChanged,
}: {
  readonly previousStateCamera: ExplorerCameraState;
  readonly stateCamera: ExplorerCameraState;
  readonly liveCamera: ExplorerCameraState;
  readonly lastCommittedCamera: ExplorerCameraState | null;
  readonly modelChanged: boolean;
}): {
  readonly nextCamera: ExplorerCameraState;
  readonly nextLastCommittedCamera: ExplorerCameraState | null;
  readonly externalCameraChanged: boolean;
} {
  const fromLocalCommit = stateCamera === lastCommittedCamera && liveCamera === lastCommittedCamera;
  const externalCameraChanged = previousStateCamera !== stateCamera && !fromLocalCommit;
  return {
    nextCamera: modelChanged || externalCameraChanged ? stateCamera : liveCamera,
    nextLastCommittedCamera: stateCamera === lastCommittedCamera ? null : lastCommittedCamera,
    externalCameraChanged,
  };
}

export function computeFocusedCameraForComponent(
  assembly: VerifiedProjectAssembly | null,
  componentId: ComponentId,
  explodeFactor: number,
  camera: ExplorerCameraState,
  separatedOffsets: Readonly<Record<string, Vector3Tuple>>,
  activeExplodeStage: ExplodeStageFilter,
): ExplorerCameraState {
  if (assembly === null) return camera;

  const nodesById: Record<string, AssemblyNode> = Object.fromEntries(
    assembly.nodes.map((node) => [node.id, node]),
  );
  const node = nodesById[componentId];
  if (node === undefined) return camera;

  const { azimuthDeg } = camera;
  const elevationDeg =
    camera.elevationDeg >= 10 && camera.elevationDeg <= 55
      ? camera.elevationDeg
      : clampNumber(camera.elevationDeg, 14, 48);
  const [x, y, z] = node.dimensionsMm;
  return {
    azimuthDeg,
    elevationDeg,
    distanceMeters: computeFrustumDistance(
      [halfExtentMeters(x), halfExtentMeters(y), halfExtentMeters(z)],
      azimuthDeg,
      elevationDeg,
      0.4,
      0.025,
    ),
    targetMeters: computeNodeWorldPositionMeters(
      node,
      nodesById,
      explodeFactor,
      separatedOffsets,
      activeExplodeStage,
    ),
  };
}

export function computeCircuitComponentIds(
  assembly: VerifiedProjectAssembly | null,
  activeComponentId: ComponentId | null,
): ReadonlySet<ComponentId> {
  if (assembly === null || activeComponentId === null) return new Set();
  const activeNode = assembly.nodes.find(({ id }) => id === activeComponentId);
  if (activeNode === undefined) return new Set();

  const drivingRelationshipId =
    activeNode.category === 'wiring' ? activeNode.specifications.relationshipId : undefined;
  const electricalRelationships = assembly.relationships.filter(
    ({ id, connectionType, fromComponentId, toComponentId }) =>
      (connectionType === 'electrical_bus' || connectionType === 'power_bus') &&
      (id === drivingRelationshipId ||
        fromComponentId === activeComponentId ||
        toComponentId === activeComponentId),
  );
  const circuitIds = new Set([activeComponentId]);
  for (const { fromComponentId, toComponentId } of electricalRelationships) {
    circuitIds.add(fromComponentId);
    circuitIds.add(toComponentId);
  }
  if (activeNode.category !== 'wiring') {
    const relationshipIds = new Set(electricalRelationships.map(({ id }) => id));
    for (const { id, category, specifications } of assembly.nodes) {
      const { relationshipId } = specifications;
      if (
        category === 'wiring' &&
        isRelationshipId(relationshipId) &&
        relationshipIds.has(relationshipId)
      ) {
        circuitIds.add(id);
      }
    }
  }
  if (circuitIds.size < 2) circuitIds.clear();
  return circuitIds;
}

function applyRebuiltAssembly(
  state: AssemblyExplorerState,
  assembly: VerifiedProjectAssembly,
  glbArrayBuffer: ArrayBuffer,
): AssemblyExplorerState {
  const nodeIds = new Set<string>(assembly.nodes.map(({ id }) => id));
  const retainId = (id: ComponentId | null) => (id !== null && nodeIds.has(id) ? id : null);
  const separatedOffsets = Object.fromEntries(
    Object.entries(state.separatedOffsets).filter(([id]) => nodeIds.has(id)),
  );
  const { viewMode } = state;
  const focus = viewMode.kind === 'part_focus' ? viewMode : null;
  const focusedComponentId = retainId(focus?.componentId ?? null);
  const bounds = computeAssemblyBoundingBoxMeters(assembly);
  const overviewCamera = computeFramedCameraForBoundingBox(
    bounds,
    focus?.restoreCamera ?? state.camera,
  );
  const explodeFactor =
    focusedComponentId === null && focus !== null
      ? focus.restoreExplodeFactor
      : state.explodeFactor;
  return {
    ...state,
    assembly,
    glbArrayBuffer,
    parameterRequestId: null,
    isRebuildingParameters: false,
    parameterErrorMessage: null,
    selectedComponentId: retainId(state.selectedComponentId),
    isolatedComponentId: retainId(state.isolatedComponentId),
    separatedOffsets,
    dismissedWarnings: INITIAL_DISMISSED_WARNINGS,
    explodeFactor,
    camera:
      focusedComponentId === null
        ? overviewCamera
        : computeFocusedCameraForComponent(
            assembly,
            focusedComponentId,
            explodeFactor,
            state.camera,
            separatedOffsets,
            state.activeExplodeStage,
          ),
    viewMode:
      focus !== null && focusedComponentId !== null
        ? { ...focus, restoreCamera: overviewCamera }
        : { kind: 'overview' },
  };
}

export function reduceAssemblyExplorerState(
  state: AssemblyExplorerState,
  action: AssemblyExplorerAction,
): AssemblyExplorerState {
  switch (action.type) {
    case 'setProvider': {
      if (action.provider === state.selectedProvider) {
        return state;
      }
      return {
        ...state,
        selectedProvider: action.provider,
      };
    }
    case 'startLoading': {
      return {
        ...state,
        lastRequestId: action.requestId,
        isLoading: true,
        loadingPhase: 'orchestrating',
        loadingProgress: 0.12,
        errorMessage: null,
        parameterRequestId: null,
        isRebuildingParameters: false,
        parameterErrorMessage: null,
      };
    }
    case 'setLoadingProgress': {
      if (
        !state.isLoading ||
        state.lastRequestId !== action.requestId ||
        state.loadingPhase === 'ready' ||
        (action.phase === 'orchestrating' && state.loadingPhase !== 'orchestrating')
      ) {
        return state;
      }
      const progress = Math.max(state.loadingProgress, clampNumber(action.progress, 0, 1));
      if (state.loadingPhase === action.phase && state.loadingProgress === progress) {
        return state;
      }
      return { ...state, loadingPhase: action.phase, loadingProgress: progress };
    }
    case 'loadAssemblySuccess': {
      if (state.lastRequestId !== null && action.requestId < state.lastRequestId) {
        return state;
      }
      return {
        ...state,
        lastRequestId: action.requestId,
        assembly: action.assembly,
        glbArrayBuffer: action.glbArrayBuffer,
        isLoading: false,
        loadingPhase: 'ready',
        loadingProgress: 1,
        errorMessage: null,
        camera: computeDefaultCameraForAssembly(action.assembly),
        viewMode: { kind: 'overview' },
        explodeFactor: 0,
        activeExplodeStage: 'all',
        wiringVisibility: 'auto',
        shellVisibility: 'solid',
        selectedComponentId: null,
        isolatedComponentId: null,
        separatedOffsets: {},
        dismissedWarnings: INITIAL_DISMISSED_WARNINGS,
      };
    }
    case 'loadAssemblyError': {
      if (state.lastRequestId !== null && action.requestId < state.lastRequestId) {
        return state;
      }
      return {
        ...state,
        isLoading: false,
        loadingPhase: 'error',
        loadingProgress: 0,
        errorMessage: action.message,
      };
    }
    case 'startParameterRebuild': {
      if (state.isLoading || state.assembly === null) return state;
      return {
        ...state,
        parameterRequestId: action.requestId,
        isRebuildingParameters: true,
        parameterErrorMessage: null,
      };
    }
    case 'rebuildParametersSuccess': {
      if (state.parameterRequestId !== action.requestId) return state;
      return applyRebuiltAssembly(state, action.assembly, action.glbArrayBuffer);
    }
    case 'rebuildParametersError': {
      if (state.parameterRequestId !== action.requestId) return state;
      return {
        ...state,
        parameterRequestId: null,
        isRebuildingParameters: false,
        parameterErrorMessage: action.message,
      };
    }
    case 'orbitCamera': {
      return {
        ...state,
        camera: orbitExplorerCamera(state.camera, action.deltaAzimuthDeg, action.deltaElevationDeg),
      };
    }
    case 'zoomCamera': {
      return {
        ...state,
        camera: zoomExplorerCamera(
          state.camera,
          action.deltaDistanceMeters,
          computeCameraZoomLimits(state.assembly),
        ),
      };
    }
    case 'resetCamera': {
      return {
        ...state,
        camera: computeDefaultCameraForAssembly(state.assembly),
      };
    }
    case 'setCamera': {
      return state.camera === action.camera ? state : { ...state, camera: action.camera };
    }
    case 'setExplodeFactor': {
      return {
        ...state,
        explodeFactor: clampNumber(action.explodeFactor, 0, 1),
      };
    }
    case 'toggleExplodePreset': {
      return { ...state, explodeFactor: state.explodeFactor > 0.001 ? 0 : DEFAULT_EXPLODE_PRESET };
    }
    case 'cycleWiringVisibility': {
      return { ...state, wiringVisibility: NEXT_WIRING_VISIBILITY[state.wiringVisibility] };
    }
    case 'setWiringVisibility': {
      return state.wiringVisibility === action.mode
        ? state
        : { ...state, wiringVisibility: action.mode };
    }
    case 'cycleShellVisibility': {
      return { ...state, shellVisibility: NEXT_SHELL_VISIBILITY[state.shellVisibility] };
    }
    case 'setShellVisibility': {
      return state.shellVisibility === action.mode
        ? state
        : { ...state, shellVisibility: action.mode };
    }
    case 'focusComponent': {
      const { componentId } = action;
      const explodeFactor =
        state.shellVisibility === 'solid'
          ? Math.max(state.explodeFactor, DEFAULT_EXPLODE_PRESET)
          : state.explodeFactor;
      const restore =
        state.viewMode.kind === 'part_focus'
          ? state.viewMode
          : { restoreCamera: state.camera, restoreExplodeFactor: state.explodeFactor };
      return {
        ...state,
        camera: computeFocusedCameraForComponent(
          state.assembly,
          componentId,
          explodeFactor,
          state.camera,
          state.separatedOffsets,
          state.activeExplodeStage,
        ),
        explodeFactor,
        selectedComponentId: componentId,
        isolatedComponentId: componentId,
        viewMode: { ...restore, kind: 'part_focus', componentId },
      };
    }
    case 'exitPartFocus': {
      if (state.viewMode.kind !== 'part_focus') return state;
      return {
        ...state,
        camera: state.viewMode.restoreCamera,
        explodeFactor: state.viewMode.restoreExplodeFactor,
        selectedComponentId: null,
        isolatedComponentId: null,
        viewMode: { kind: 'overview' },
      };
    }
    case 'setExplodeStage': {
      return {
        ...state,
        activeExplodeStage: action.stage,
      };
    }
    case 'selectComponent': {
      const nextIsolated =
        action.componentId === null
          ? null
          : state.isolatedComponentId !== null
            ? action.componentId
            : null;
      return {
        ...state,
        selectedComponentId: action.componentId,
        isolatedComponentId: nextIsolated,
      };
    }
    case 'toggleIsolateComponent': {
      if (state.selectedComponentId === null) {
        return state;
      }
      const nextIsolated =
        state.isolatedComponentId === state.selectedComponentId ? null : state.selectedComponentId;
      return {
        ...state,
        isolatedComponentId: nextIsolated,
      };
    }
    case 'separateComponentAlongAxis': {
      if (state.selectedComponentId === null) {
        return state;
      }
      const id = state.selectedComponentId;
      return {
        ...state,
        separatedOffsets: {
          ...state.separatedOffsets,
          [id]: addAxisDelta(state.separatedOffsets[id], action.axis, action.deltaMeters),
        },
      };
    }
    case 'resetComponentSeparation': {
      if (state.selectedComponentId === null) {
        return {
          ...state,
          separatedOffsets: {},
        };
      }
      const remaining: Record<string, Vector3Tuple> = {};
      for (const [key, value] of Object.entries(state.separatedOffsets)) {
        if (key !== state.selectedComponentId) {
          remaining[key] = value;
        }
      }
      return {
        ...state,
        separatedOffsets: remaining,
      };
    }
    case 'dismissInspectionWarning': {
      if (state.dismissedWarnings[action.warning]) {
        return state;
      }
      return {
        ...state,
        dismissedWarnings: {
          ...state.dismissedWarnings,
          [action.warning]: true,
        },
      };
    }
  }
}
