import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useReducer, useRef } from 'react';

import { type AiProviderId, type ComponentId, type VerifiedProjectAssembly } from '@/shared/domain';

import {
  INITIAL_LEARNING_STATE,
  type LearningAction,
  type LearningState,
  reduceLearningState,
} from '../model/learningState';
import { runLearningRequest } from '../services/learningEngine';

export type LearningQuestionSubmission = {
  readonly id: number;
  readonly targetComponentId: ComponentId;
  readonly question: string;
};

type LearningInputs = {
  readonly assembly: VerifiedProjectAssembly | null;
  readonly focusedComponentId: ComponentId | null;
  readonly submittedQuestion: LearningQuestionSubmission | null;
  readonly selectedProvider: AiProviderId;
  readonly providerExplicitlySelected: boolean;
};

function useLearningRequest(
  slot: 'explanation' | 'answer',
  callout: LearningState[typeof slot],
  { assembly, selectedProvider, providerExplicitlySelected }: LearningInputs,
  dispatch: (action: LearningAction) => void,
) {
  const requestId = callout.kind === 'idle' ? null : callout.requestId;
  const startRequest = useEffectEvent(() => {
    if (assembly === null || callout.kind !== 'loading') return;
    const { componentId, question, requestId } = callout;
    let cancelled = false;
    let streamedText = '';

    void runLearningRequest({
      assembly,
      componentId,
      request: question === undefined ? { kind: 'explain' } : { kind: 'question', question },
      provider: selectedProvider,
      providerExplicitlySelected,
      onChunk: (chunk, metadata) => {
        if (cancelled) return;
        streamedText += chunk;
        dispatch({ type: 'write', slot, requestId, text: streamedText.trimStart(), ...metadata });
      },
    })
      .then((result) => {
        if (!cancelled) dispatch({ type: 'complete', slot, requestId, ...result });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : 'Learning details are unavailable.';
          dispatch({ type: 'fail', slot, requestId, message });
        }
      });

    return () => {
      cancelled = true;
    };
  });

  useEffect(() => (requestId === null ? undefined : startRequest()), [requestId]);
}

export function useComponentLearning(inputs: LearningInputs) {
  const { assembly, focusedComponentId, submittedQuestion } = inputs;
  const projectId = assembly?.projectId ?? null;
  const targetComponentId = assembly === null ? null : (focusedComponentId ?? assembly.rootNodeId);
  const [state, dispatch] = useReducer(reduceLearningState, INITIAL_LEARNING_STATE);
  const lastContext = useRef<{
    projectId: VerifiedProjectAssembly['projectId'] | null;
    targetComponentId: ComponentId | null;
    questionId: number | null;
  }>({ projectId: null, targetComponentId: null, questionId: null });

  useLayoutEffect(() => {
    const previous = lastContext.current;
    const questionId = submittedQuestion?.id ?? null;
    lastContext.current = { projectId, targetComponentId, questionId };

    const changedProject = previous.projectId !== projectId;
    if (changedProject) dispatch({ type: 'reset' });
    if (assembly === null) return;

    if (changedProject || previous.targetComponentId !== targetComponentId) {
      const component = assembly.nodes.find(({ id }) => id === targetComponentId);
      if (component === undefined) {
        dispatch({ type: 'reset', slot: 'explanation' });
      } else {
        dispatch({
          type: 'activateExplanation',
          componentId: component.id,
          componentName: component.name,
        });
      }
    }

    if (submittedQuestion !== null && previous.questionId !== questionId) {
      const component = assembly.nodes.find(({ id }) => id === submittedQuestion.targetComponentId);
      if (component !== undefined) {
        dispatch({
          type: 'start',
          slot: 'answer',
          componentId: component.id,
          componentName: component.name,
          question: submittedQuestion.question,
        });
      }
    }
  }, [assembly, projectId, submittedQuestion, targetComponentId]);

  useLearningRequest('explanation', state.explanation, inputs, dispatch);
  useLearningRequest('answer', state.answer, inputs, dispatch);

  const dismissAnswer = useCallback(() => dispatch({ type: 'reset', slot: 'answer' }), []);
  return { state, dismissAnswer };
}
