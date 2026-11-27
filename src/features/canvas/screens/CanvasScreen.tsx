import { useReducer, useState } from 'react';

import { type AiProviderId, DEFAULT_AI_PROVIDER } from '@/shared/domain';

import {
  AssemblyExplorerView,
  type ActiveExplorerLearningContext,
  type AssemblyExplorerRequest,
} from '@/features/assembly-explorer';
import { classifyCanvasPrompt, type LearningQuestionSubmission } from '@/features/learning';

import { CanvasView } from '../components/CanvasView';
import {
  INITIAL_CANVAS_COMPOSER_STATE,
  canSubmitPrompt,
  normalizePromptDraft,
  reduceCanvasComposerState,
} from '../model/composerState';
import { type CanvasScreenProps } from '../types';

export function CanvasScreen({
  initialArchetypeId,
  onBackToCatalog,
  onSubmitPrompt,
}: CanvasScreenProps) {
  const [state, dispatch] = useReducer(reduceCanvasComposerState, INITIAL_CANVAS_COMPOSER_STATE);
  const [selectedProvider, setSelectedProvider] = useState<AiProviderId>(DEFAULT_AI_PROVIDER);
  const [providerExplicitlySelected, setProviderExplicitlySelected] = useState(false);
  const [activeLearningContext, setActiveLearningContext] =
    useState<ActiveExplorerLearningContext | null>(null);
  const [assemblyRequest, setAssemblyRequest] = useState<AssemblyExplorerRequest | null>(
    initialArchetypeId === undefined
      ? null
      : { kind: 'archetype', id: 0, archetypeId: initialArchetypeId },
  );
  const [submittedQuestion, setSubmittedQuestion] = useState<LearningQuestionSubmission | null>(
    null,
  );
  const canSubmit = canSubmitPrompt(state.draft);
  const focusedName = activeLearningContext?.focusedComponentName ?? null;
  const placeholder =
    focusedName !== null
      ? `Ask about ${focusedName}...`
      : activeLearningContext === null
        ? 'Describe a CAD assembly to explore...'
        : 'Ask a question or describe another CAD assembly...';

  function handleDraftChange(text: string) {
    dispatch({ type: 'changeDraft', text });
  }

  function handleSubmit() {
    const normalized = normalizePromptDraft(state.draft);
    if (normalized.length === 0) return;
    const classification = classifyCanvasPrompt(normalized, activeLearningContext);
    const id = state.nextSubmissionId;
    if (classification.kind === 'load_assembly') {
      setAssemblyRequest({ kind: 'prompt', id, text: normalized });
      setSubmittedQuestion(null);
    } else {
      setSubmittedQuestion({
        id,
        question: normalized,
        targetComponentId: classification.targetComponentId,
      });
    }
    dispatch({ type: 'submit' });
    onSubmitPrompt?.(normalized);
  }

  function handleSelectProvider(provider: AiProviderId) {
    setSelectedProvider(provider);
    setProviderExplicitlySelected(true);
  }

  const surfaceContent =
    assemblyRequest !== null ? (
      <AssemblyExplorerView
        request={assemblyRequest}
        submittedQuestion={submittedQuestion}
        onActiveLearningContextChange={setActiveLearningContext}
        selectedProvider={selectedProvider}
        providerExplicitlySelected={providerExplicitlySelected}
        onSelectProvider={handleSelectProvider}
        onResolveProvider={setSelectedProvider}
      />
    ) : null;

  return (
    <CanvasView
      draft={state.draft}
      placeholder={placeholder}
      canSubmit={canSubmit}
      surfaceContent={surfaceContent}
      onBackToCatalog={onBackToCatalog}
      onDraftChange={handleDraftChange}
      onSubmit={handleSubmit}
    />
  );
}
