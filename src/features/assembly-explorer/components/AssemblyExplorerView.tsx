import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useReducedMotion } from 'react-native-reanimated';

import {
  type AiProviderId,
  type ComponentId,
  DEFAULT_AI_PROVIDER,
  type ExplodeStageFilter,
  getAiProviderDescriptor,
  isVerifiedStatus,
  SUPPORTED_AI_PROVIDERS,
} from '@/shared/domain';

import { useComponentLearning } from '@/features/learning';

import {
  INITIAL_ASSEMBLY_EXPLORER_STATE,
  reduceAssemblyExplorerState,
} from '../model/explorerState';
import { AssemblyScene } from '../renderer/AssemblyScene';
import {
  loadVerifiedAssemblyForPrompt,
  rebuildAssemblyForParameters,
} from '../services/assemblyRuntimeService';
import {
  type AssemblyExplorerProps,
  type ExplorerCameraState,
  type SeparationAxis,
} from '../types';

const LOADING_CAPTION = 'Loading CAD assembly';

function AssemblyLoadingBar({
  progress,
  overlay = false,
}: {
  readonly progress: number;
  readonly overlay?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const percent = Math.round(progress * 100);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={LOADING_CAPTION}
      accessibilityValue={{ min: 0, max: 100, now: percent }}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      style={[styles.progressTrack, overlay && styles.progressOverlay]}>
      <Animated.View
        style={[
          styles.progressFill,
          {
            width: `${progress * 100}%`,
            transitionProperty: 'width',
            transitionDuration: reducedMotion ? 0 : 160,
          },
        ]}
      />
    </View>
  );
}

function ProviderSwitcher({
  selectedProvider,
  onSelectProvider,
}: {
  readonly selectedProvider: AiProviderId;
  readonly onSelectProvider: (provider: AiProviderId) => void;
}) {
  return (
    <View style={styles.providerRow} accessibilityRole="toolbar">
      {SUPPORTED_AI_PROVIDERS.map((providerId) => {
        const descriptor = getAiProviderDescriptor(providerId);
        const active = providerId === selectedProvider;
        return (
          <Pressable
            key={providerId}
            accessibilityRole="button"
            accessibilityLabel={`Use ${descriptor.displayName}`}
            accessibilityState={{ selected: active }}
            style={[styles.providerButton, active ? styles.providerButtonActive : null]}
            onPress={() => onSelectProvider(providerId)}>
            <Text style={active ? styles.providerLabelActive : styles.providerLabel}>
              {descriptor.displayName}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function AssemblyExplorerView({
  submittedPrompt,
  submittedQuestion = null,
  onActiveLearningContextChange,
  selectedProvider,
  providerExplicitlySelected,
  onSelectProvider,
  onResolveProvider,
}: AssemblyExplorerProps) {
  const [state, dispatch] = useReducer(
    reduceAssemblyExplorerState,
    INITIAL_ASSEMBLY_EXPLORER_STATE,
  );
  const parameterRequest = useRef<AbortController | null>(null);
  const nextParameterRequestId = useRef(0);
  const assembly = state.errorMessage === null ? state.assembly : null;
  const focusedComponentId =
    state.viewMode.kind === 'part_focus' ? state.viewMode.componentId : null;
  const { state: learningState, dismissAnswer } = useComponentLearning({
    assembly,
    focusedComponentId,
    submittedQuestion,
    selectedProvider,
    providerExplicitlySelected,
  });

  useLayoutEffect(() => {
    onActiveLearningContextChange?.(
      assembly === null || !isVerifiedStatus(assembly.verificationStatus)
        ? null
        : {
            assembly,
            focusedComponentId,
            focusedComponentName:
              assembly.nodes.find(({ id }) => id === focusedComponentId)?.name ?? null,
          },
    );
  }, [assembly, focusedComponentId, onActiveLearningContextChange]);

  const requestedProvider = providerExplicitlySelected ? selectedProvider : DEFAULT_AI_PROVIDER;
  const setCamera = useCallback(
    (camera: ExplorerCameraState) => dispatch({ type: 'setCamera', camera }),
    [],
  );
  const exitPartFocus = useCallback(() => dispatch({ type: 'exitPartFocus' }), []);

  const applyParameters = useCallback(
    (parameterValues: Readonly<Record<string, number>>) => {
      if (assembly === null || state.isLoading) return;
      parameterRequest.current?.abort();
      const controller = new AbortController();
      parameterRequest.current = controller;
      const requestId = ++nextParameterRequestId.current;
      dispatch({ type: 'startParameterRebuild', requestId });

      void rebuildAssemblyForParameters({ assembly, parameterValues, signal: controller.signal })
        .then(({ assembly: updatedAssembly, glbArrayBuffer }) => {
          if (controller.signal.aborted) return;
          dispatch({
            type: 'rebuildParametersSuccess',
            requestId,
            assembly: updatedAssembly,
            glbArrayBuffer,
          });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          dispatch({
            type: 'rebuildParametersError',
            requestId,
            message: error instanceof Error ? error.message : 'Unable to rebuild CAD assembly',
          });
        })
        .finally(() => {
          if (parameterRequest.current === controller) parameterRequest.current = null;
        });
    },
    [assembly, state.isLoading],
  );

  useEffect(() => {
    dispatch({ type: 'setProvider', provider: selectedProvider });
  }, [selectedProvider]);

  useEffect(() => {
    if (submittedPrompt === null) {
      return;
    }

    let cancelled = false;
    const promptId = submittedPrompt.id;
    dispatch({ type: 'startLoading', promptId });

    void loadVerifiedAssemblyForPrompt({
      prompt: submittedPrompt.text,
      provider: requestedProvider,
      providerExplicitlySelected,
      onProgress: (progress) => {
        if (!cancelled) {
          dispatch({ type: 'setLoadingProgress', promptId, ...progress });
        }
      },
    })
      .then((bundle) => {
        if (cancelled) {
          return;
        }
        dispatch({
          type: 'loadAssemblySuccess',
          promptId,
          assembly: bundle.assembly,
          glbArrayBuffer: bundle.glbArrayBuffer,
        });
        onResolveProvider(bundle.assembly.orchestration.provider);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message =
          error instanceof Error ? error.message : 'Unable to load CAD assembly bundle';
        dispatch({ type: 'loadAssemblyError', promptId, message });
      });

    return () => {
      cancelled = true;
      parameterRequest.current?.abort();
    };
  }, [submittedPrompt, requestedProvider, providerExplicitlySelected, onResolveProvider]);

  useEffect(() => {
    const promptId = state.lastPromptId;
    if (state.loadingPhase !== 'orchestrating' || promptId === null) return;

    const startedAt = Date.now();
    const interval = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      dispatch({
        type: 'setLoadingProgress',
        promptId,
        phase: 'orchestrating',
        progress: 0.5 - 0.38 * Math.exp(-elapsedMs / 2500),
      });
    }, 120);
    return () => clearInterval(interval);
  }, [state.lastPromptId, state.loadingPhase]);

  if (state.isLoading && state.assembly === null) {
    return (
      <View style={styles.statusContainer}>
        <Text style={styles.statusText}>{LOADING_CAPTION}…</Text>
        <AssemblyLoadingBar progress={state.loadingProgress} />
      </View>
    );
  }

  if (state.errorMessage !== null) {
    return (
      <View style={styles.statusContainer}>
        <View style={styles.errorCard}>
          <Text accessibilityRole="alert" style={styles.errorText}>
            {state.errorMessage}
          </Text>
          <ProviderSwitcher
            selectedProvider={state.selectedProvider}
            onSelectProvider={onSelectProvider}
          />
        </View>
      </View>
    );
  }

  if (state.assembly === null) {
    return null;
  }

  return (
    <View style={styles.sceneContainer}>
      <AssemblyScene
        assembly={state.assembly}
        glbArrayBuffer={state.glbArrayBuffer}
        state={state}
        learningState={learningState}
        onDismissLearningAnswer={dismissAnswer}
        onApplyParameters={applyParameters}
        onSetCamera={setCamera}
        onSetExplodeFactor={(explodeFactor: number) =>
          dispatch({ type: 'setExplodeFactor', explodeFactor })
        }
        onToggleExplodePreset={() => dispatch({ type: 'toggleExplodePreset' })}
        onCycleWiringVisibility={() => dispatch({ type: 'cycleWiringVisibility' })}
        onCycleShellVisibility={() => dispatch({ type: 'cycleShellVisibility' })}
        onFocusComponent={(componentId) => dispatch({ type: 'focusComponent', componentId })}
        onExitPartFocus={exitPartFocus}
        onSetExplodeStage={(stage: ExplodeStageFilter) =>
          dispatch({ type: 'setExplodeStage', stage })
        }
        onSelectComponent={(componentId: ComponentId | null) =>
          dispatch({ type: 'selectComponent', componentId })
        }
        onToggleIsolate={() => dispatch({ type: 'toggleIsolateComponent' })}
        onSeparateComponent={(axis: SeparationAxis, deltaMeters: number) =>
          dispatch({ type: 'separateComponentAlongAxis', axis, deltaMeters })
        }
        onResetSeparation={() => dispatch({ type: 'resetComponentSeparation' })}
        onSelectProvider={onSelectProvider}
      />
      {state.isLoading ? <AssemblyLoadingBar progress={state.loadingProgress} overlay /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sceneContainer: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
  },
  statusContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  progressTrack: {
    pointerEvents: 'none',
    width: 180,
    height: 4,
    maxWidth: '100%',
    borderRadius: 2,
    backgroundColor: '#2B261D',
    overflow: 'hidden',
  },
  progressOverlay: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    height: 2,
    borderRadius: 0,
    zIndex: 26,
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: '#F5C451',
  },
  statusText: {
    color: '#CFC4B0',
    fontSize: 14,
    fontWeight: '500',
  },
  errorCard: {
    width: '100%',
    maxWidth: 420,
    padding: 22,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#4A3E28',
    backgroundColor: '#12110EEB',
    boxShadow: '0 18px 56px #00000066',
  },
  errorText: {
    color: '#FAF6ED',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  providerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    marginTop: 16,
  },
  providerButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#4A3E28',
    backgroundColor: '#1A1712',
  },
  providerButtonActive: {
    borderColor: '#F5C451',
    backgroundColor: '#332914',
  },
  providerLabel: {
    color: '#CFC4B0',
    fontSize: 13,
    fontWeight: '600',
  },
  providerLabelActive: {
    color: '#FDE68A',
    fontSize: 13,
    fontWeight: '600',
  },
});
