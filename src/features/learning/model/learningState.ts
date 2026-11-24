import {
  type ComponentId,
  type LearningContextSource,
  type LearningInferenceSource,
} from '@/shared/domain';

type SlotKind = 'explanation' | 'answer';
type IdentifiedCallout = {
  readonly requestId: number;
  readonly componentId: ComponentId;
  readonly componentName: string;
};

type CalloutText = {
  readonly text: string;
  readonly contextSource: LearningContextSource;
} & (
  | { readonly inferenceSource: Extract<LearningInferenceSource, 'on_device'> }
  | {
      readonly inferenceSource: 'cloud';
      readonly fallbackReason: string;
      readonly providerName: string;
    }
  | { readonly inferenceSource: 'offline_cache'; readonly fallbackReason: string }
);

type CachedExplanationEntry = Pick<IdentifiedCallout, 'componentId' | 'componentName'> &
  CalloutText;

export type LearningCalloutSlotState<Question extends string | undefined = string | undefined> =
  | { readonly kind: 'idle' }
  | (IdentifiedCallout & { readonly question: Question } & (
        | { readonly kind: 'loading' }
        | ({ readonly kind: 'writing' } & CalloutText)
        | ({ readonly kind: 'ready'; readonly restoredFromCache?: true } & CalloutText)
        | { readonly kind: 'error'; readonly message: string }
      ));

export type ExplanationSlotState = LearningCalloutSlotState<undefined>;
export type AnswerSlotState = LearningCalloutSlotState<string>;

export type LearningState = {
  readonly explanation: ExplanationSlotState;
  readonly answer: AnswerSlotState;
  readonly cachedExplanations: Readonly<Record<string, CachedExplanationEntry>>;
  readonly nextRequestId: number;
};

type StartAction = {
  readonly type: 'start';
  readonly componentId: ComponentId;
  readonly componentName: string;
} & ({ readonly slot: 'explanation' } | { readonly slot: 'answer'; readonly question: string });

type UpdateAction = { readonly slot: SlotKind; readonly requestId: number } & (
  | ({ readonly type: 'write' | 'complete' } & CalloutText)
  | { readonly type: 'fail'; readonly message: string }
);

export type LearningAction =
  | StartAction
  | UpdateAction
  | ({ readonly type: 'activateExplanation' } & Pick<
      IdentifiedCallout,
      'componentId' | 'componentName'
    >)
  | { readonly type: 'reset'; readonly slot?: SlotKind };

export const INITIAL_LEARNING_STATE: LearningState = {
  explanation: { kind: 'idle' },
  answer: { kind: 'idle' },
  cachedExplanations: {},
  nextRequestId: 1,
};

function updateSlot<Question extends string | undefined>(
  slot: LearningCalloutSlotState<Question>,
  action: UpdateAction,
): LearningCalloutSlotState<Question> {
  if (
    slot.kind === 'idle' ||
    slot.requestId !== action.requestId ||
    slot.kind === 'ready' ||
    slot.kind === 'error'
  )
    return slot;

  const { componentId, componentName, requestId, question } = slot;
  const identity = { componentId, componentName, requestId, question };
  switch (action.type) {
    case 'write':
    case 'complete': {
      const { type, slot: _slot, requestId: _requestId, ...text } = action;
      return { ...identity, ...text, kind: type === 'write' ? 'writing' : 'ready' };
    }
    case 'fail':
      return { kind: 'error', ...identity, message: action.message };
  }
}

export function reduceLearningState(state: LearningState, action: LearningAction): LearningState {
  switch (action.type) {
    case 'reset':
      return {
        ...state,
        explanation: action.slot === 'answer' ? state.explanation : { kind: 'idle' },
        answer: action.slot === 'explanation' ? state.answer : { kind: 'idle' },
        cachedExplanations: action.slot === undefined ? {} : state.cachedExplanations,
      };
    case 'activateExplanation':
    case 'start': {
      const { componentId, componentName } = action;
      const requestId = state.nextRequestId;
      const nextRequestId = requestId + 1;
      const loading = {
        kind: 'loading',
        requestId,
        componentId,
        componentName,
      } satisfies IdentifiedCallout & { readonly kind: 'loading' };
      if (action.type === 'start' && action.slot === 'answer') {
        return { ...state, answer: { ...loading, question: action.question }, nextRequestId };
      }

      const cached =
        action.type === 'activateExplanation' &&
        Object.hasOwn(state.cachedExplanations, componentId)
          ? state.cachedExplanations[componentId]
          : undefined;
      const explanation: ExplanationSlotState =
        cached === undefined
          ? { ...loading, question: undefined }
          : { ...cached, kind: 'ready', requestId, question: undefined, restoredFromCache: true };
      return { ...state, explanation, nextRequestId };
    }
    case 'write':
    case 'complete':
    case 'fail': {
      if (action.slot === 'explanation') {
        const explanation = updateSlot(state.explanation, action);
        if (explanation === state.explanation) return state;
        if (explanation.kind !== 'ready') return { ...state, explanation };

        const {
          kind: _kind,
          requestId: _requestId,
          question: _question,
          restoredFromCache: _restoredFromCache,
          ...cached
        } = explanation;
        return {
          ...state,
          explanation,
          cachedExplanations: { ...state.cachedExplanations, [cached.componentId]: cached },
        };
      }
      const answer = updateSlot(state.answer, action);
      return answer === state.answer ? state : { ...state, answer };
    }
  }
}
