import type { CalloutRect } from '@/features/learning';

type Size = Pick<CalloutRect, 'width' | 'height'>;
export type CalloutAnchor = readonly [x: number, y: number];

const VIEWPORT_MARGIN = 16;
const OBSTACLE_GAP = 8;

function overlaps(rect: CalloutRect, obstacle: CalloutRect): boolean {
  return (
    rect.x < obstacle.x + obstacle.width + OBSTACLE_GAP &&
    rect.x + rect.width + OBSTACLE_GAP > obstacle.x &&
    rect.y < obstacle.y + obstacle.height + OBSTACLE_GAP &&
    rect.y + rect.height + OBSTACLE_GAP > obstacle.y
  );
}

export function computePartCalloutRect({
  anchor: [anchorX, anchorY],
  labelSize: { width, height },
  viewport,
  obstacles,
}: {
  readonly anchor: CalloutAnchor;
  readonly labelSize: Size;
  readonly viewport: Size;
  readonly obstacles: readonly CalloutRect[];
}): CalloutRect | null {
  const min = VIEWPORT_MARGIN;
  const maxX = viewport.width - min - width;
  const maxY = viewport.height - min - height;
  if (width <= 0 || height <= 0 || maxX < min || maxY < min) return null;

  const occupied = [...obstacles, { x: anchorX - 16, y: anchorY - 16, width: 32, height: 32 }];
  const preferred: readonly CalloutAnchor[] = [
    [anchorX + 54, anchorY - height - 24],
    [anchorX + 54, anchorY - height / 2],
    [anchorX - width - 54, anchorY - height - 24],
    [anchorX - width / 2, anchorY - height - 46],
    [anchorX - width - 54, anchorY - height / 2],
    [anchorX - width / 2, anchorY + 46],
  ];
  const xs = [min, maxX, ...preferred.map(([x]) => x)];
  const ys = [min, maxY, ...preferred.map(([, y]) => y)];
  for (const obstacle of occupied) {
    xs.push(obstacle.x - width - OBSTACLE_GAP, obstacle.x + obstacle.width + OBSTACLE_GAP);
    ys.push(obstacle.y - height - OBSTACLE_GAP, obstacle.y + obstacle.height + OBSTACLE_GAP);
  }
  const candidateXs = new Set(xs.map((x) => Math.max(min, Math.min(maxX, x))));
  const candidateYs = new Set(ys.map((y) => Math.max(min, Math.min(maxY, y))));
  let placement: CalloutRect | null = null;
  let bestScore = Infinity;
  for (const x of candidateXs) {
    for (const y of candidateYs) {
      const rect = { x, y, width, height };
      if (occupied.some((obstacle) => overlaps(rect, obstacle))) continue;
      let score = Infinity;
      for (const [index, [idealX, idealY]] of preferred.entries()) {
        score = Math.min(score, Math.hypot(x - idealX, y - idealY) + index * 14);
      }
      if (score < bestScore) {
        placement = rect;
        bestScore = score;
      }
    }
  }
  return placement;
}
