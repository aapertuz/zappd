type Point = { readonly x: number; readonly y: number };
type Size = { readonly width: number; readonly height: number };
export type CalloutRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type PartAnchors = {
  readonly center: Point;
  readonly left: Point;
  readonly right: Point;
  readonly top: Point;
  readonly bottom: Point;
};

export type LearningCalloutPlacement = {
  readonly rect: CalloutRect;
  readonly anchor: Point;
  readonly leaderPath: string;
  readonly arrowPath: string;
};

export type LearningCalloutsLayout = {
  readonly explanation: LearningCalloutPlacement | null;
  readonly answer: LearningCalloutPlacement | null;
};

type PositionCandidate = { readonly rect: CalloutRect; readonly score: number };

const CARD_GAP = 12;
const DESKTOP_LEADER_STANDOFF = 54;

function right(rect: CalloutRect): number {
  return rect.x + rect.width;
}

function bottom(rect: CalloutRect): number {
  return rect.y + rect.height;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function overlaps(rect: CalloutRect, obstacle: CalloutRect): boolean {
  return (
    rect.x < right(obstacle) + CARD_GAP &&
    right(rect) + CARD_GAP > obstacle.x &&
    rect.y < bottom(obstacle) + CARD_GAP &&
    bottom(rect) + CARD_GAP > obstacle.y
  );
}

function findCandidates(
  size: Size | null,
  preferred: Point,
  bounds: CalloutRect,
  obstacles: readonly CalloutRect[],
  nextSize?: Size | null,
): readonly PositionCandidate[] {
  if (
    size === null ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0 ||
    size.height > bounds.height ||
    bounds.width <= 0
  )
    return [];

  const width = Math.min(size.width, bounds.width);
  const { height } = size;
  const maxX = right(bounds) - width;
  const maxY = bottom(bounds) - height;
  const xPositions = [bounds.x, maxX, preferred.x];
  const yPositions = [bounds.y, maxY, preferred.y];
  for (const obstacle of obstacles) {
    xPositions.push(obstacle.x - width - CARD_GAP, right(obstacle) + CARD_GAP);
    yPositions.push(obstacle.y - height - CARD_GAP, bottom(obstacle) + CARD_GAP);
  }
  if (nextSize != null) {
    const xOffset = nextSize.width + CARD_GAP;
    const yOffset = nextSize.height + CARD_GAP;
    xPositions.push(...xPositions.flatMap((x) => [x - xOffset, x + xOffset]));
    yPositions.push(...yPositions.flatMap((y) => [y - yOffset, y + yOffset]));
  }

  const xs = new Set(xPositions.map((x) => clamp(x, bounds.x, maxX)));
  const ys = new Set(yPositions.map((y) => clamp(y, bounds.y, maxY)));
  const candidates: PositionCandidate[] = [];
  for (const x of xs) {
    for (const y of ys) {
      const rect = { x, y, width, height };
      if (obstacles.every((obstacle) => !overlaps(rect, obstacle))) {
        candidates.push({ rect, score: Math.abs(x - preferred.x) + Math.abs(y - preferred.y) });
      }
    }
  }
  return candidates.sort((left, right) => left.score - right.score);
}

function placeCallout(
  rect: CalloutRect | undefined,
  anchors: PartAnchors,
): LearningCalloutPlacement | null {
  if (rect === undefined) return null;
  const edges = [
    { start: { x: rect.x, y: rect.y + rect.height / 2 }, end: anchors.right, horizontal: true },
    { start: { x: right(rect), y: rect.y + rect.height / 2 }, end: anchors.left, horizontal: true },
    { start: { x: rect.x + rect.width / 2, y: rect.y }, end: anchors.bottom, horizontal: false },
    { start: { x: rect.x + rect.width / 2, y: bottom(rect) }, end: anchors.top, horizontal: false },
  ];
  const facing = edges.filter(({ start, end, horizontal }) =>
    horizontal
      ? start.x === rect.x
        ? end.x <= start.x
        : end.x >= start.x
      : start.y === rect.y
        ? end.y <= start.y
        : end.y >= start.y,
  );
  const edge = facing.sort(
    (a, b) =>
      Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y) -
      Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y),
  )[0];
  if (edge === undefined) return null;

  const { start, end: anchor, horizontal } = edge;
  const elbow = horizontal
    ? {
        x: start.x + Math.sign(anchor.x - start.x) * Math.min(22, Math.abs(anchor.x - start.x) / 3),
        y: start.y,
      }
    : {
        x: start.x,
        y: start.y + Math.sign(anchor.y - start.y) * Math.min(22, Math.abs(anchor.y - start.y) / 3),
      };
  const dx = anchor.x - elbow.x;
  const dy = anchor.y - elbow.y;
  const distance = Math.hypot(dx, dy);
  const unitX = dx / distance;
  const unitY = dy / distance;
  const tipGap = Math.min(10, distance * 0.55);
  const arrowLength = Math.min(7, distance - tipGap);
  const halfWidth = Math.min(3, arrowLength / 2);
  const tip = { x: anchor.x - tipGap * unitX, y: anchor.y - tipGap * unitY };
  const base = { x: tip.x - arrowLength * unitX, y: tip.y - arrowLength * unitY };

  return {
    rect,
    anchor,
    leaderPath: `M ${start.x} ${start.y} L ${elbow.x} ${elbow.y} L ${base.x} ${base.y}`,
    arrowPath: `M ${tip.x} ${tip.y} L ${base.x - halfWidth * unitY} ${base.y + halfWidth * unitX} L ${base.x + halfWidth * unitY} ${base.y - halfWidth * unitX} Z`,
  };
}

export type LearningCalloutsGeometryFrame = {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly partLabelRect: CalloutRect | null;
  readonly anchors: PartAnchors | null;
  readonly answerAnchors?: PartAnchors | null;
  readonly obstacles?: readonly CalloutRect[];
};

function projectedPartRect(anchors: PartAnchors): CalloutRect {
  return {
    x: anchors.left.x,
    y: anchors.top.y,
    width: anchors.right.x - anchors.left.x,
    height: anchors.bottom.y - anchors.top.y,
  };
}

export function computeLearningCalloutsLayout({
  viewportWidth,
  viewportHeight,
  partLabelRect,
  anchors,
  answerAnchors = anchors,
  obstacles = [],
  explanationSize,
  answerSize,
  margin = 16,
  topInset = viewportWidth <= 800 ? 122 : 84,
  bottomInset = 112,
}: LearningCalloutsGeometryFrame & {
  readonly explanationSize: Size | null;
  readonly answerSize: Size | null;
  readonly margin?: number;
  readonly topInset?: number;
  readonly bottomInset?: number;
}): LearningCalloutsLayout {
  const bounds = {
    x: margin,
    y: topInset,
    width: viewportWidth - margin * 2,
    height: viewportHeight - topInset - bottomInset,
  };
  const occupiedRects = [
    ...obstacles,
    ...(anchors === null ? [] : [projectedPartRect(anchors)]),
    ...(answerAnchors === null || answerAnchors === anchors
      ? []
      : [projectedPartRect(answerAnchors)]),
    ...(partLabelRect === null ? [] : [partLabelRect]),
  ];
  const mobile = viewportWidth <= 800;
  const explanationWidth = Math.min(explanationSize?.width ?? 0, bounds.width);
  const answerWidth = Math.min(answerSize?.width ?? 0, bounds.width);
  const explanationHeight = explanationSize?.height ?? 0;
  const explanationPreferred =
    anchors === null
      ? null
      : mobile
        ? {
            x: anchors.center.x - explanationWidth / 2,
            y: anchors.top.y - explanationHeight - CARD_GAP,
          }
        : {
            x: anchors.left.x - explanationWidth - DESKTOP_LEADER_STANDOFF,
            y: anchors.center.y - explanationHeight / 2,
          };
  const answerPreferred =
    answerAnchors === null
      ? null
      : {
          x: mobile
            ? answerAnchors.center.x - answerWidth / 2
            : answerAnchors.right.x + DESKTOP_LEADER_STANDOFF,
          y: mobile ? answerAnchors.bottom.y + CARD_GAP : answerAnchors.center.y + 28,
        };

  const explanations =
    explanationPreferred === null
      ? []
      : findCandidates(explanationSize, explanationPreferred, bounds, occupiedRects, answerSize);
  let explanation = explanations[0];
  let answer =
    answerPreferred === null
      ? undefined
      : findCandidates(answerSize, answerPreferred, bounds, occupiedRects)[0];
  let bestPairScore = Number.POSITIVE_INFINITY;

  if (answerPreferred !== null && answerSize !== null && answer !== undefined) {
    for (const candidate of explanations) {
      if (candidate.score >= bestPairScore) break;
      const pairedAnswer = findCandidates(answerSize, answerPreferred, bounds, [
        ...occupiedRects,
        candidate.rect,
      ])[0];
      if (pairedAnswer !== undefined && candidate.score + pairedAnswer.score < bestPairScore) {
        explanation = candidate;
        answer = pairedAnswer;
        bestPairScore = candidate.score + pairedAnswer.score;
      }
    }
    if (bestPairScore === Number.POSITIVE_INFINITY) explanation = undefined;
  }

  return {
    explanation: anchors === null ? null : placeCallout(explanation?.rect, anchors),
    answer: answerAnchors === null ? null : placeCallout(answer?.rect, answerAnchors),
  };
}
