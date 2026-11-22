import { useEffect, useReducer } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { type ComponentId, type ExplodeStageFilter } from '@/shared/domain';

import {
  INITIAL_ASSEMBLY_EXPLORER_STATE,
  reduceAssemblyExplorerState,
} from '../model/explorerState';
import { AssemblyScene } from '../renderer/AssemblyScene';
import { loadVerifiedAssemblyForPrompt } from '../services/assemblyRuntimeService';
import { type AssemblyExplorerProps, type SeparationAxis } from '../types';

export function AssemblyExplorerView({
  submittedPrompt,
  selectedProvider,
  onSelectProvider,
}: AssemblyExplorerProps) {
  const [state, dispatch] = useReducer(
    reduceAssemblyExplorerState,
    INITIAL_ASSEMBLY_EXPLORER_STATE,
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
      provider: selectedProvider,
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
  }, [submittedPrompt, selectedProvider]);

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
  },
});
