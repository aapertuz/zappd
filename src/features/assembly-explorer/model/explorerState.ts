import type { AiProviderId, Vector3Tuple } from '@/shared/domain';

import type {
  AssemblyExplorerAction,
  AssemblyExplorerState,
  ExplorerCameraState,
  SeparationAxis,
} from '../types';

export const DEFAULT_EXPLORER_CAMERA: ExplorerCameraState = {
  azimuthDeg: 38,
  elevationDeg: 26,
  distanceMeters: 0.42,
  targetMeters: [0, 0.04, 0],
};

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
      const isArm = action.assembly.archetypeId === 'robotic_arm_3dof_v1';
      return {
        ...state,
        lastPromptId: action.promptId,
        assembly: action.assembly,
        glbArrayBuffer: action.glbArrayBuffer,
        isLoading: false,
        errorMessage: null,
        camera: {
          ...DEFAULT_EXPLORER_CAMERA,
          targetMeters: isArm ? [0.04, 0.1, 0] : DEFAULT_EXPLORER_CAMERA.targetMeters,
          distanceMeters: isArm ? 0.44 : DEFAULT_EXPLORER_CAMERA.distanceMeters,
        },
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
        0.14,
        1.5,
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
      const isArm = state.assembly?.archetypeId === 'robotic_arm_3dof_v1';
      return {
        ...state,
        camera: {
          ...DEFAULT_EXPLORER_CAMERA,
          targetMeters: isArm ? [0.04, 0.1, 0] : DEFAULT_EXPLORER_CAMERA.targetMeters,
          distanceMeters: isArm ? 0.44 : DEFAULT_EXPLORER_CAMERA.distanceMeters,
        },
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
