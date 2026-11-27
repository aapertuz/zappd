import { useEffect, useReducer, useRef, useState } from 'react';

import { type AiProviderId, DEFAULT_AI_PROVIDER } from '@/shared/domain';

import {
  AssemblyExplorerView,
  type ActiveExplorerLearningContext,
  type AssemblyExplorerProps,
  type AssemblyExplorerRequest,
} from '@/features/assembly-explorer';
import { resolveCanvasPromptRoute, type LearningQuestionSubmission } from '@/features/learning';

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
  const [submittedParameterEdit, setSubmittedParameterEdit] =
    useState<AssemblyExplorerProps['submittedParameterEdit']>(null);
  const [submittedQuestion, setSubmittedQuestion] = useState<LearningQuestionSubmission | null>(
    null,
  );
  const [unsupportedNotice, setUnsupportedNotice] = useState<string | null>(null);
  const routingRequest = useRef<AbortController | null>(null);
  const canSubmit = canSubmitPrompt(state.draft);
  const focusedName = activeLearningContext?.focusedComponentName ?? null;
  const placeholder =
    focusedName !== null
      ? `Ask about ${focusedName}...`
      : activeLearningContext === null
        ? 'Describe a CAD assembly to explore...'
        : 'Ask a question or describe another CAD assembly...';

  useEffect(() => () => routingRequest.current?.abort(), []);

  function handleDraftChange(text: string) {
    if (text !== state.draft) setUnsupportedNotice(null);
    dispatch({ type: 'changeDraft', text });
  }

  async function handleSubmit() {
    const normalized = normalizePromptDraft(state.draft);
    if (normalized.length === 0) return;
    const id = state.nextSubmissionId;
    routingRequest.current?.abort();
    const controller = new AbortController();
    routingRequest.current = controller;
    setUnsupportedNotice(null);
    dispatch({ type: 'submit' });
    onSubmitPrompt?.(normalized);

    try {
      const { decision } = await resolveCanvasPromptRoute({
        prompt: normalized,
        activeContext: activeLearningContext,
        provider: selectedProvider,
        providerExplicitlySelected,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      if (decision.kind === 'unsupported_modify') {
        setUnsupportedNotice(decision.reason);
      } else if (decision.kind === 'ask_question') {
        setSubmittedQuestion({
          id,
          question: normalized,
          targetComponentId: decision.targetComponentId,
        });
      } else {
        setSubmittedQuestion(null);
        const assembly = activeLearningContext?.assembly;
        if (
          decision.kind === 'modify_assembly' &&
          assembly?.archetypeId === decision.targetArchetypeId &&
          assembly.parameters?.length
        ) {
          setSubmittedParameterEdit({ id, parameterValues: decision.parameterValues });
        } else {
          setSubmittedParameterEdit(null);
          setAssemblyRequest({
            kind: 'prompt',
            id,
            text: normalized,
            archetypeId: decision.targetArchetypeId,
            parameterValues: decision.parameterValues,
          });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (routingRequest.current === controller) routingRequest.current = null;
    }
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
        submittedParameterEdit={submittedParameterEdit}
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
      notice={unsupportedNotice}
      onDismissNotice={() => setUnsupportedNotice(null)}
      onDraftChange={handleDraftChange}
      onSubmit={handleSubmit}
    />
  );
}
