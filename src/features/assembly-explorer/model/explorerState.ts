import type { AiProviderId, Vector3Tuple, VerifiedProjectAssembly } from '@/shared/domain';

import type {
  AssemblyExplorerAction,
  AssemblyExplorerState,
  ExplorerCameraState,
  SeparationAxis,
} from '../types';

export const DEFAULT_EXPLORER_CAMERA: ExplorerCameraState = {
  azimuthDeg: 38,
  elevationDeg: 28,
  distanceMeters: 0.38,
  targetMeters: [0, 0.018, 0],
};

export function computeDefaultCameraForAssembly(
  assembly: VerifiedProjectAssembly | null,
): ExplorerCameraState {
  if (assembly === null) {
    return DEFAULT_EXPLORER_CAMERA;
  }
  switch (assembly.archetypeId) {
    case 'robotic_arm_3dof_v1':
      return {
        azimuthDeg: 42,
        elevationDeg: 24,
        distanceMeters: 0.36,
        targetMeters: [0, 0.082, 0.045],
      };
    case 'open_source_rover_v1':
      return {
        azimuthDeg: 36,
        elevationDeg: 26,
        distanceMeters: 0.42,
        targetMeters: [0, 0.035, 0],
      };
    default:
      return DEFAULT_EXPLORER_CAMERA;
  }
}

const INITIAL_EXPLORER_PROVIDER: AiProviderId = 'deepseek';

export const INITIAL_ASSEMBLY_EXPLORER_STATE: AssemblyExplorerState = {
  selectedProvider: INITIAL_EXPLORER_PROVIDER,
  lastPromptId: null,
  assembly: null,
  glbArrayBuffer: null,
  isLoading: false,
  loadingPhase: 'idle',
  loadingProgress: 0,
  errorMessage: null,
  camera: DEFAULT_EXPLORER_CAMERA,
  explodeFactor: 0,
  activeExplodeStage: 'all',
  selectedComponentId: null,
  isolatedComponentId: null,
  separatedOffsets: {},
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
): ExplorerCameraState {
  return {
    ...camera,
    distanceMeters: clampNumber(camera.distanceMeters + deltaDistanceMeters, 0.08, 1.8),
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
        lastPromptId: action.promptId,
        isLoading: true,
        loadingPhase: 'orchestrating',
        loadingProgress: 0.12,
        errorMessage: null,
      };
    }
    case 'setLoadingProgress': {
      if (
        !state.isLoading ||
        state.lastPromptId !== action.promptId ||
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
      if (state.lastPromptId !== null && action.promptId < state.lastPromptId) {
        return state;
      }
      return {
        ...state,
        lastPromptId: action.promptId,
        assembly: action.assembly,
        glbArrayBuffer: action.glbArrayBuffer,
        isLoading: false,
        loadingPhase: 'ready',
        loadingProgress: 1,
        errorMessage: null,
        camera: computeDefaultCameraForAssembly(action.assembly),
        explodeFactor: 0,
        activeExplodeStage: 'all',
        selectedComponentId: null,
        isolatedComponentId: null,
        separatedOffsets: {},
      };
    }
    case 'loadAssemblyError': {
      if (state.lastPromptId !== null && action.promptId < state.lastPromptId) {
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
    case 'orbitCamera': {
      return {
        ...state,
        camera: orbitExplorerCamera(state.camera, action.deltaAzimuthDeg, action.deltaElevationDeg),
      };
    }
    case 'zoomCamera': {
      return {
        ...state,
        camera: zoomExplorerCamera(state.camera, action.deltaDistanceMeters),
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
  }
}
