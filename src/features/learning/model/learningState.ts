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

export type LearningCalloutSlotState<Question extends string | undefined = string | undefined> =
  | { readonly kind: 'idle' }
  | (IdentifiedCallout & { readonly question: Question } & (
        | { readonly kind: 'loading' }
        | ({ readonly kind: 'writing' | 'ready' } & CalloutText)
        | { readonly kind: 'error'; readonly message: string }
      ));

export type ExplanationSlotState = LearningCalloutSlotState<undefined>;
export type AnswerSlotState = LearningCalloutSlotState<string>;

export type LearningState = {
  readonly explanation: ExplanationSlotState;
  readonly answer: AnswerSlotState;
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
  StartAction | UpdateAction | { readonly type: 'reset'; readonly slot?: SlotKind };

export const INITIAL_LEARNING_STATE: LearningState = {
  explanation: { kind: 'idle' },
  answer: { kind: 'idle' },
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
      };
    case 'start': {
      const { componentId, componentName } = action;
      const loading = {
        kind: 'loading',
        requestId: state.nextRequestId,
        componentId,
        componentName,
      } as const;
      return action.slot === 'explanation'
        ? {
            ...state,
            explanation: { ...loading, question: undefined },
            nextRequestId: state.nextRequestId + 1,
          }
        : {
            ...state,
            answer: { ...loading, question: action.question },
            nextRequestId: state.nextRequestId + 1,
          };
    }
    case 'write':
    case 'complete':
    case 'fail': {
      if (action.slot === 'explanation') {
        const explanation = updateSlot(state.explanation, action);
        return explanation === state.explanation ? state : { ...state, explanation };
      }
      const answer = updateSlot(state.answer, action);
      return answer === state.answer ? state : { ...state, answer };
    }
  }
}
