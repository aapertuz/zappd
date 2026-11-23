type TypewriterProgress = {
  readonly currentVisibleLength: number;
  readonly targetText: string;
};

export function advanceTypewriterProgress({
  currentVisibleLength,
  targetText,
  dtMs,
  charsPerSecond,
  reducedMotion,
}: TypewriterProgress & {
  readonly dtMs: number;
  readonly charsPerSecond: number;
  readonly reducedMotion: boolean;
}): number {
  if (reducedMotion) return targetText.length;
  const elapsedCharacters = (Math.max(0, dtMs) * Math.max(0, charsPerSecond)) / 1000;
  return Math.min(targetText.length, Math.max(0, currentVisibleLength) + elapsedCharacters);
}

export function isTypewriterWriting({
  currentVisibleLength,
  targetText,
}: TypewriterProgress): boolean {
  return Math.floor(currentVisibleLength) < targetText.length;
}
