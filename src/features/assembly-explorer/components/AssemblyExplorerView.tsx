import { useEffect, useReducer } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  type AiProviderId,
  type ComponentId,
  DEFAULT_AI_PROVIDER,
  type ExplodeStageFilter,
  getAiProviderDescriptor,
  SUPPORTED_AI_PROVIDERS,
} from '@/shared/domain';

import {
  INITIAL_ASSEMBLY_EXPLORER_STATE,
  reduceAssemblyExplorerState,
} from '../model/explorerState';
import { AssemblyScene } from '../renderer/AssemblyScene';
import { loadVerifiedAssemblyForPrompt } from '../services/assemblyRuntimeService';
import { type AssemblyExplorerProps, type SeparationAxis } from '../types';

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
  selectedProvider,
  providerExplicitlySelected,
  onSelectProvider,
  onResolveProvider,
}: AssemblyExplorerProps) {
  const [state, dispatch] = useReducer(
    reduceAssemblyExplorerState,
    INITIAL_ASSEMBLY_EXPLORER_STATE,
  );
  const requestedProvider = providerExplicitlySelected ? selectedProvider : DEFAULT_AI_PROVIDER;

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
    };
  }, [submittedPrompt, requestedProvider, providerExplicitlySelected, onResolveProvider]);

  if (state.isLoading && state.assembly === null) {
    return (
      <View style={styles.statusContainer}>
        <Text style={styles.statusText}>Loading verified CAD assembly…</Text>
      </View>
    );
  }

  if (state.errorMessage !== null) {
    return (
      <View style={styles.statusContainer}>
        <Text style={styles.errorText}>{state.errorMessage}</Text>
        <ProviderSwitcher
          selectedProvider={state.selectedProvider}
          onSelectProvider={onSelectProvider}
        />
      </View>
    );
  }

  if (state.assembly === null) {
    return null;
  }

  return (
    <AssemblyScene
      assembly={state.assembly}
      glbArrayBuffer={state.glbArrayBuffer}
      state={state}
      onOrbitCamera={(deltaAzimuthDeg: number, deltaElevationDeg: number) =>
        dispatch({ type: 'orbitCamera', deltaAzimuthDeg, deltaElevationDeg })
      }
      onZoomCamera={(deltaDistanceMeters: number) =>
        dispatch({ type: 'zoomCamera', deltaDistanceMeters })
      }
      onResetCamera={() => dispatch({ type: 'resetCamera' })}
      onSetExplodeFactor={(explodeFactor: number) =>
        dispatch({ type: 'setExplodeFactor', explodeFactor })
      }
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
  );
}

const styles = StyleSheet.create({
  statusContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  statusText: {
    color: '#52525b',
    fontSize: 14,
    fontWeight: '500',
  },
  errorText: {
    color: '#dc2626',
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
    borderColor: '#d4d4d8',
    backgroundColor: '#ffffff',
  },
  providerButtonActive: {
    borderColor: '#18181b',
    backgroundColor: '#18181b',
  },
  providerLabel: {
    color: '#18181b',
    fontSize: 13,
    fontWeight: '600',
  },
  providerLabelActive: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
});
