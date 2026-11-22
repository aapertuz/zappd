import { useReducer, useState } from 'react';

import { type AiProviderId, DEFAULT_AI_PROVIDER } from '@/shared/domain';

import { AssemblyExplorerView } from '@/features/assembly-explorer';

import { CanvasView } from '../components/CanvasView';
import {
  INITIAL_CANVAS_COMPOSER_STATE,
  canSubmitPrompt,
  normalizePromptDraft,
  reduceCanvasComposerState,
} from '../model/composerState';
import { type CanvasScreenProps } from '../types';

export function CanvasScreen({ onSubmitPrompt }: CanvasScreenProps) {
  const [state, dispatch] = useReducer(reduceCanvasComposerState, INITIAL_CANVAS_COMPOSER_STATE);
  const [selectedProvider, setSelectedProvider] = useState<AiProviderId>(DEFAULT_AI_PROVIDER);
  const [providerExplicitlySelected, setProviderExplicitlySelected] = useState(false);
  const canSubmit = canSubmitPrompt(state.draft);

  function handleDraftChange(text: string) {
    dispatch({ type: 'changeDraft', text });
  }

  function handleSubmit() {
    const normalized = normalizePromptDraft(state.draft);
    if (normalized.length === 0) return;
    dispatch({ type: 'submit' });
    onSubmitPrompt?.(normalized);
  }

  function handleSelectProvider(provider: AiProviderId) {
    setSelectedProvider(provider);
    setProviderExplicitlySelected(true);
  }

  const surfaceContent =
    state.lastSubmittedPrompt !== null ? (
      <AssemblyExplorerView
        submittedPrompt={state.lastSubmittedPrompt}
        selectedProvider={selectedProvider}
        providerExplicitlySelected={providerExplicitlySelected}
        onSelectProvider={handleSelectProvider}
        onResolveProvider={setSelectedProvider}
      />
    ) : null;

  return (
    <CanvasView
      draft={state.draft}
      canSubmit={canSubmit}
      surfaceContent={surfaceContent}
      onDraftChange={handleDraftChange}
      onSubmit={handleSubmit}
    />
  );
}
