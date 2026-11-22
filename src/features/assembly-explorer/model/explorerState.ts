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
        errorMessage: null,
      };
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
        errorMessage: action.message,
      };
    }
    case 'orbitCamera': {
      const nextAzimuth = (state.camera.azimuthDeg + action.deltaAzimuthDeg + 360) % 360;
      const nextElevation = clampNumber(
        state.camera.elevationDeg + action.deltaElevationDeg,
        -80,
        85,
      );
      return {
        ...state,
        camera: {
          ...state.camera,
          azimuthDeg: nextAzimuth,
          elevationDeg: nextElevation,
        },
      };
    }
    case 'zoomCamera': {
      const nextDistance = clampNumber(
        state.camera.distanceMeters + action.deltaDistanceMeters,
        0.08,
        1.8,
      );
      return {
        ...state,
        camera: {
          ...state.camera,
          distanceMeters: nextDistance,
        },
      };
    }
    case 'resetCamera': {
      return {
        ...state,
        camera: computeDefaultCameraForAssembly(state.assembly),
      };
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
