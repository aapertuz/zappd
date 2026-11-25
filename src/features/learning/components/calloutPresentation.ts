import { type LearningInferenceSource } from '@/shared/domain';

import { useTypewriterText } from '../hooks/useTypewriterText';
import { type CalloutRect, type LearningCalloutsGeometryFrame } from '../model/calloutLayout';
import { type LearningCalloutSlotState, type LearningState } from '../model/learningState';

export type LearningCalloutsRenderedRects = {
  readonly explanationRect: CalloutRect | null;
  readonly answerRect: CalloutRect | null;
};

export type LearningCalloutsHandle = {
  readonly syncGeometry: (frame: LearningCalloutsGeometryFrame) => LearningCalloutsRenderedRects;
};

export type LearningCalloutsProps = {
  readonly learningState: LearningState;
  readonly explanationIsOverview?: boolean;
  readonly answeringInOverview?: boolean;
  readonly onDismissAnswer: () => void;
};

const SOURCE_LABELS = {
  on_device: 'On-Device',
  cloud: 'Cloud',
  offline_cache: 'Cached',
} satisfies Record<LearningInferenceSource, string>;

export function useCalloutPresentation(slot: LearningCalloutSlotState, loadingText: string) {
  const hasResponse = slot.kind === 'writing' || slot.kind === 'ready';
  const text = hasResponse ? slot.text : '';
  const inferenceSource = hasResponse ? slot.inferenceSource : null;
  const resetKey = slot.kind === 'idle' ? 'idle' : `${slot.requestId}:${inferenceSource ?? ''}`;
  const { visibleText, isWriting } = useTypewriterText(
    text,
    resetKey,
    slot.kind === 'ready' && slot.restoredFromCache === true,
  );
  const body =
    slot.kind === 'loading' ? loadingText : slot.kind === 'error' ? slot.message : visibleText;

  return {
    body,
    visibleText,
    isWriting,
    showCursor: isWriting || slot.kind === 'loading' || slot.kind === 'writing',
    fullLength: text.length,
    contextSource: hasResponse ? slot.contextSource : null,
    inferenceSource,
    sourceLabel: inferenceSource === null ? null : SOURCE_LABELS[inferenceSource],
  };
}
