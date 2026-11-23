type Point = { readonly x: number; readonly y: number };
type Size = { readonly width: number; readonly height: number };
type Rect = Point & Size;

type PartAnchors = {
  readonly center: Point;
  readonly left: Point;
  readonly right: Point;
  readonly top: Point;
  readonly bottom: Point;
};

export type LearningCalloutPlacement = {
  readonly rect: Rect;
  readonly leaderPath: string;
};

export type LearningCalloutsLayout = {
  readonly explanation: LearningCalloutPlacement | null;
  readonly answer: LearningCalloutPlacement | null;
};

type PositionCandidate = { readonly rect: Rect; readonly score: number };

const CARD_GAP = 12;

function right(rect: Rect): number {
  return rect.x + rect.width;
}

function bottom(rect: Rect): number {
  return rect.y + rect.height;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function overlaps(rect: Rect, obstacle: Rect): boolean {
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
  bounds: Rect,
  obstacles: readonly Rect[],
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
  rect: Rect | undefined,
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
  if (edge === undefined) return { rect, leaderPath: '' };

  const { start, end, horizontal } = edge;
  const elbow = horizontal
    ? `H ${start.x + (end.x - start.x) / 2} V ${end.y}`
    : `V ${start.y + (end.y - start.y) / 2} H ${end.x}`;
  return { rect, leaderPath: `M ${start.x} ${start.y} ${elbow} L ${end.x} ${end.y}` };
}

export function computeLearningCalloutsLayout({
  viewportWidth,
  viewportHeight,
  partLabelRect,
  anchors,
  explanationSize,
  answerSize,
  margin = 16,
  topInset = viewportWidth <= 800 ? 122 : 84,
  bottomInset = 194,
}: {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly partLabelRect: Rect | null;
  readonly anchors: PartAnchors;
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
  const partRect = {
    x: anchors.left.x,
    y: anchors.top.y,
    width: anchors.right.x - anchors.left.x,
    height: anchors.bottom.y - anchors.top.y,
  };
  const obstacles = partLabelRect === null ? [partRect] : [partRect, partLabelRect];
  const mobile = viewportWidth <= 800;
  const explanationWidth = Math.min(explanationSize?.width ?? 0, bounds.width);
  const answerWidth = Math.min(answerSize?.width ?? 0, bounds.width);
  const explanationPreferred = mobile
    ? {
        x: anchors.center.x - explanationWidth / 2,
        y: anchors.top.y - (explanationSize?.height ?? 0) - CARD_GAP,
      }
    : { x: anchors.right.x + CARD_GAP, y: anchors.center.y - (explanationSize?.height ?? 0) / 2 };
  const answerPreferred = mobile
    ? { x: anchors.center.x - answerWidth / 2, y: anchors.bottom.y + CARD_GAP }
    : {
        x: anchors.left.x - answerWidth - CARD_GAP,
        y: anchors.center.y - (answerSize?.height ?? 0) / 2,
      };

  const explanations = findCandidates(
    explanationSize,
    explanationPreferred,
    bounds,
    obstacles,
    answerSize,
  );
  let explanation = explanations[0];
  let answer = findCandidates(answerSize, answerPreferred, bounds, obstacles)[0];
  let bestPairScore = Number.POSITIVE_INFINITY;

  for (const candidate of explanations) {
    if (candidate.score >= bestPairScore || answerSize === null) break;
    const pairedAnswer = findCandidates(answerSize, answerPreferred, bounds, [
      ...obstacles,
      candidate.rect,
    ])[0];
    if (pairedAnswer !== undefined && candidate.score + pairedAnswer.score < bestPairScore) {
      explanation = candidate;
      answer = pairedAnswer;
      bestPairScore = candidate.score + pairedAnswer.score;
    }
  }
  if (explanation !== undefined && bestPairScore === Number.POSITIVE_INFINITY) answer = undefined;

  return {
    explanation: placeCallout(explanation?.rect, anchors),
    answer: placeCallout(answer?.rect, anchors),
  };
}
