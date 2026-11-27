import {
  type AiProviderId,
  type CatalogArchetypeId,
  type ComponentId,
  type ExplodeStageFilter,
  type Vector3Tuple,
  type VerifiedProjectAssembly,
} from '@/shared/domain';

import { type LearningQuestionSubmission, type LearningState } from '@/features/learning';

export type SeparationAxis = 'x' | 'y' | 'z';

export type WiringVisibilityMode = 'auto' | 'show' | 'hide';
export type ShellVisibilityMode = 'solid' | 'xray' | 'hidden';

export type AssemblyLoadingPhase = 'idle' | 'orchestrating' | 'downloading' | 'ready' | 'error';

export type AssemblyLoadingProgress = {
  readonly phase: Exclude<AssemblyLoadingPhase, 'idle' | 'error'>;
  readonly progress: number;
};

export type ExplorerCameraState = {
  readonly azimuthDeg: number;
  readonly elevationDeg: number;
  readonly distanceMeters: number;
  readonly targetMeters: Vector3Tuple;
};

export type ExplorerViewMode =
  | { readonly kind: 'overview' }
  | {
      readonly kind: 'part_focus';
      readonly componentId: ComponentId;
      readonly restoreCamera: ExplorerCameraState;
      readonly restoreExplodeFactor: number;
    };

export type AssemblyExplorerState = {
  readonly selectedProvider: AiProviderId;
  readonly lastRequestId: number | null;
  readonly assembly: VerifiedProjectAssembly | null;
  readonly glbArrayBuffer: ArrayBuffer | null;
  readonly isLoading: boolean;
  readonly loadingPhase: AssemblyLoadingPhase;
  readonly loadingProgress: number;
  readonly errorMessage: string | null;
  readonly parameterRequestId: number | null;
  readonly isRebuildingParameters: boolean;
  readonly parameterErrorMessage: string | null;
  readonly camera: ExplorerCameraState;
  readonly viewMode: ExplorerViewMode;
  readonly explodeFactor: number;
  readonly activeExplodeStage: ExplodeStageFilter;
  readonly wiringVisibility: WiringVisibilityMode;
  readonly shellVisibility: ShellVisibilityMode;
  readonly selectedComponentId: ComponentId | null;
  readonly isolatedComponentId: ComponentId | null;
  readonly separatedOffsets: Readonly<Record<string, Vector3Tuple>>;
};

export type AssemblyExplorerAction =
  | { readonly type: 'setProvider'; readonly provider: AiProviderId }
  | { readonly type: 'startLoading'; readonly requestId: number }
  | ({ readonly type: 'setLoadingProgress'; readonly requestId: number } & AssemblyLoadingProgress)
  | {
      readonly type: 'loadAssemblySuccess';
      readonly requestId: number;
      readonly assembly: VerifiedProjectAssembly;
      readonly glbArrayBuffer: ArrayBuffer;
    }
  | { readonly type: 'loadAssemblyError'; readonly requestId: number; readonly message: string }
  | { readonly type: 'startParameterRebuild'; readonly requestId: number }
  | {
      readonly type: 'rebuildParametersSuccess';
      readonly requestId: number;
      readonly assembly: VerifiedProjectAssembly;
      readonly glbArrayBuffer: ArrayBuffer;
    }
  | {
      readonly type: 'rebuildParametersError';
      readonly requestId: number;
      readonly message: string;
    }
  | {
      readonly type: 'orbitCamera';
      readonly deltaAzimuthDeg: number;
      readonly deltaElevationDeg: number;
    }
  | { readonly type: 'zoomCamera'; readonly deltaDistanceMeters: number }
  | { readonly type: 'resetCamera' }
  | { readonly type: 'setCamera'; readonly camera: ExplorerCameraState }
  | { readonly type: 'setExplodeFactor'; readonly explodeFactor: number }
  | { readonly type: 'toggleExplodePreset' }
  | { readonly type: 'cycleWiringVisibility' }
  | { readonly type: 'setWiringVisibility'; readonly mode: WiringVisibilityMode }
  | { readonly type: 'cycleShellVisibility' }
  | { readonly type: 'setShellVisibility'; readonly mode: ShellVisibilityMode }
  | { readonly type: 'focusComponent'; readonly componentId: ComponentId }
  | { readonly type: 'exitPartFocus' }
  | { readonly type: 'setExplodeStage'; readonly stage: ExplodeStageFilter }
  | { readonly type: 'selectComponent'; readonly componentId: ComponentId | null }
  | { readonly type: 'toggleIsolateComponent' }
  | {
      readonly type: 'separateComponentAlongAxis';
      readonly axis: SeparationAxis;
      readonly deltaMeters: number;
    }
  | { readonly type: 'resetComponentSeparation' };

export type AssemblySceneProps = {
  readonly learningState: LearningState;
  readonly onDismissLearningAnswer: () => void;
  readonly assembly: VerifiedProjectAssembly;
  readonly glbArrayBuffer: ArrayBuffer | null;
  readonly state: AssemblyExplorerState;
  readonly onApplyParameters: (parameterValues: Readonly<Record<string, number>>) => void;
  readonly onSetCamera: (camera: ExplorerCameraState) => void;
  readonly onSetExplodeFactor: (explodeFactor: number) => void;
  readonly onToggleExplodePreset: () => void;
  readonly onCycleWiringVisibility: () => void;
  readonly onCycleShellVisibility: () => void;
  readonly onFocusComponent: (componentId: ComponentId) => void;
  readonly onExitPartFocus: () => void;
  readonly onSetExplodeStage: (stage: ExplodeStageFilter) => void;
  readonly onSelectComponent: (componentId: ComponentId | null) => void;
  readonly onToggleIsolate: () => void;
  readonly onSeparateComponent: (axis: SeparationAxis, deltaMeters: number) => void;
  readonly onResetSeparation: () => void;
  readonly onSelectProvider: (provider: AiProviderId) => void;
};

export type ActiveExplorerLearningContext = {
  readonly assembly: VerifiedProjectAssembly;
  readonly focusedComponentId: ComponentId | null;
  readonly focusedComponentName: string | null;
};

export type AssemblyExplorerRequest =
  | { readonly kind: 'archetype'; readonly id: number; readonly archetypeId: CatalogArchetypeId }
  | {
      readonly kind: 'prompt';
      readonly id: number;
      readonly text: string;
      readonly archetypeId?: CatalogArchetypeId;
      readonly parameterValues?: Readonly<Record<string, number>>;
    };

export type AssemblyExplorerProps = {
  readonly submittedQuestion?: LearningQuestionSubmission | null;
  readonly onActiveLearningContextChange?: (context: ActiveExplorerLearningContext | null) => void;
  readonly request: AssemblyExplorerRequest;
  readonly submittedParameterEdit?: {
    readonly id: number;
    readonly parameterValues: Readonly<Record<string, number>>;
  } | null;
  readonly selectedProvider: AiProviderId;
  readonly providerExplicitlySelected: boolean;
  readonly onSelectProvider: (provider: AiProviderId) => void;
  readonly onResolveProvider: (provider: AiProviderId) => void;
};
