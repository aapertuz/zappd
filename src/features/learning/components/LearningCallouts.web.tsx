import {
  type Ref,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';

import {
  type LearningCalloutsHandle,
  type LearningCalloutsProps,
  useCalloutPresentation,
} from './calloutPresentation';
import classes from './LearningCallouts.web.module.css';
import {
  type CalloutRect,
  computeLearningCalloutsLayout,
  type LearningCalloutPlacement,
  type LearningCalloutsGeometryFrame,
} from '../model/calloutLayout';
import { type LearningCalloutSlotState } from '../model/learningState';

type CalloutPresentation = ReturnType<typeof useCalloutPresentation>;
type CalloutDiagnostics = {
  readonly kind: Exclude<LearningCalloutSlotState['kind'], 'idle'>;
  readonly componentId: Exclude<LearningCalloutSlotState, { kind: 'idle' }>['componentId'];
  readonly question?: string;
  readonly contextSource: CalloutPresentation['contextSource'];
  readonly inferenceSource: CalloutPresentation['inferenceSource'];
  readonly fullLength: number;
  readonly visibleLength: number;
  readonly isWriting: boolean;
  readonly visibleText: string;
};
type DiagnosticsSnapshot = (CalloutDiagnostics & { readonly rect: CalloutRect | null }) | null;

declare global {
  interface Window {
    readonly __zappdLearningDiagnostics?: {
      readonly explanation: DiagnosticsSnapshot;
      readonly answer: DiagnosticsSnapshot;
    };
  }
}

function useAnnotationElements() {
  const card = useRef<HTMLDivElement>(null);
  const drawing = useRef<SVGSVGElement>(null);
  const leader = useRef<SVGPathElement>(null);
  const arrow = useRef<SVGPathElement>(null);
  const reticle = useRef<SVGGElement>(null);
  const dimensions = useRef<{ width: number; height: number } | null>(null);
  return useMemo(() => ({ card, drawing, leader, arrow, reticle, dimensions }), []);
}

type AnnotationElements = ReturnType<typeof useAnnotationElements>;

function positionAnnotation(
  elements: AnnotationElements,
  placement: LearningCalloutPlacement | null,
) {
  const { card, drawing, leader, arrow, reticle } = elements;
  const visibility = placement === null ? 'hidden' : 'visible';
  if (card.current !== null) card.current.style.visibility = visibility;
  if (drawing.current !== null) drawing.current.style.visibility = visibility;
  if (placement === null) return;
  const { rect, anchor, leaderPath, arrowPath } = placement;
  if (card.current !== null) card.current.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
  leader.current?.setAttribute('d', leaderPath);
  arrow.current?.setAttribute('d', arrowPath);
  reticle.current?.setAttribute('transform', `translate(${anchor.x} ${anchor.y})`);
}

function snapshot(
  slot: LearningCalloutSlotState,
  { contextSource, inferenceSource, fullLength, visibleText, isWriting }: CalloutPresentation,
): CalloutDiagnostics | null {
  if (slot.kind === 'idle') return null;
  return {
    kind: slot.kind,
    componentId: slot.componentId,
    question: slot.question,
    contextSource,
    inferenceSource,
    fullLength,
    visibleLength: visibleText.length,
    isWriting,
    visibleText,
  };
}

function Annotation({
  title,
  label,
  elements,
  presentation,
  question,
  onDismiss,
}: {
  readonly title: string;
  readonly label: string;
  readonly elements: AnnotationElements;
  readonly presentation: CalloutPresentation;
  readonly question?: string;
  readonly onDismiss?: () => void;
}) {
  const {
    card: cardRef,
    drawing: drawingRef,
    leader: leaderRef,
    arrow: arrowRef,
    reticle: reticleRef,
  } = elements;
  const bodyRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const bodyElement = bodyRef.current;
    if (bodyElement !== null && presentation.isWriting) {
      bodyElement.scrollTop = bodyElement.scrollHeight;
    }
  }, [presentation.body, presentation.isWriting]);

  return (
    <>
      <svg
        ref={drawingRef}
        className={classes.drawing}
        width="100%"
        height="100%"
        aria-hidden="true">
        <path ref={leaderRef} className={classes.leader} />
        <path ref={arrowRef} className={classes.arrow} />
        <g ref={reticleRef} className={classes.reticle}>
          <circle r="7.5" />
          <circle r="3" />
          <circle r="1" fill="currentColor" />
        </g>
      </svg>
      <div ref={cardRef} className={classes.card} role="status" aria-label={label}>
        <div className={classes.header}>
          <span className={classes.eyebrow}>{title}</span>
          {presentation.sourceLabel !== null ? (
            <span className={classes.source}>{presentation.sourceLabel}</span>
          ) : null}
          {onDismiss !== undefined ? (
            <button
              className={classes.dismiss}
              type="button"
              aria-label="Dismiss answer"
              onClick={onDismiss}>
              ×
            </button>
          ) : null}
        </div>
        {question !== undefined ? (
          <div className={classes.question} title={question}>
            {question}
          </div>
        ) : null}
        <div ref={bodyRef} className={classes.body}>
          {presentation.body}
          {presentation.showCursor ? (
            <span className={classes.cursor} aria-hidden="true">
              ▍
            </span>
          ) : null}
        </div>
      </div>
    </>
  );
}

export function LearningCallouts({
  learningState,
  explanationIsOverview,
  answeringInOverview,
  onDismissAnswer,
  ref,
}: LearningCalloutsProps & { readonly ref?: Ref<LearningCalloutsHandle> }) {
  const { explanation, answer } = learningState;
  const explanationElements = useAnnotationElements();
  const answerElements = useAnnotationElements();
  const frameRef = useRef<LearningCalloutsGeometryFrame | null>(null);
  const snapshots = useRef<{
    explanation: CalloutDiagnostics | null;
    answer: CalloutDiagnostics | null;
  }>({
    explanation: null,
    answer: null,
  });
  const explanationPresentation = useCalloutPresentation(
    explanation,
    explanationIsOverview ? 'Putting together a quick overview…' : 'Getting a simple explanation…',
  );
  const answerPresentation = useCalloutPresentation(answer, 'Looking up an answer…');

  const syncGeometry = useCallback(
    (frame: LearningCalloutsGeometryFrame) => {
      frameRef.current = frame;
      const layout = computeLearningCalloutsLayout({
        ...frame,
        explanationSize: explanationElements.dimensions.current,
        answerSize: answerElements.dimensions.current,
      });
      positionAnnotation(explanationElements, layout.explanation);
      positionAnnotation(answerElements, layout.answer);
      const explanationRect = layout.explanation?.rect ?? null;
      const answerRect = layout.answer?.rect ?? null;
      const { explanation, answer } = snapshots.current;
      Object.defineProperty(window, '__zappdLearningDiagnostics', {
        configurable: true,
        value: {
          explanation: explanation === null ? null : { ...explanation, rect: explanationRect },
          answer: answer === null ? null : { ...answer, rect: answerRect },
        },
      });
      return { explanationRect, answerRect };
    },
    [answerElements, explanationElements],
  );

  const refreshGeometry = useCallback(() => {
    for (const { card, dimensions } of [explanationElements, answerElements]) {
      dimensions.current =
        card.current === null
          ? null
          : {
              width: card.current.offsetWidth,
              height: card.current.offsetHeight,
            };
    }
    if (frameRef.current !== null) syncGeometry(frameRef.current);
  }, [answerElements, explanationElements, syncGeometry]);

  useImperativeHandle(ref, () => ({ syncGeometry }), [syncGeometry]);

  useLayoutEffect(() => {
    snapshots.current = {
      explanation: snapshot(explanation, explanationPresentation),
      answer: snapshot(answer, answerPresentation),
    };
    refreshGeometry();
  });

  const hasExplanation = explanation.kind !== 'idle';
  const hasAnswer = answer.kind !== 'idle';

  useLayoutEffect(() => {
    const observer = new ResizeObserver(refreshGeometry);
    if (explanationElements.card.current !== null)
      observer.observe(explanationElements.card.current);
    if (answerElements.card.current !== null) observer.observe(answerElements.card.current);
    return () => observer.disconnect();
  }, [hasExplanation, hasAnswer, answerElements, explanationElements, refreshGeometry]);

  useLayoutEffect(
    () => () => {
      Reflect.deleteProperty(window, '__zappdLearningDiagnostics');
    },
    [],
  );

  return (
    <div className={classes.overlay}>
      {hasExplanation ? (
        <Annotation
          title={explanationIsOverview ? 'Overview' : 'Explanation'}
          label="Component explanation"
          elements={explanationElements}
          presentation={explanationPresentation}
        />
      ) : null}
      {answer.kind !== 'idle' ? (
        <Annotation
          title={answeringInOverview ? `Answer · ${answer.componentName}` : 'Answer'}
          label="Learning answer"
          elements={answerElements}
          presentation={answerPresentation}
          question={answer.question}
          onDismiss={onDismissAnswer}
        />
      ) : null}
    </div>
  );
}
