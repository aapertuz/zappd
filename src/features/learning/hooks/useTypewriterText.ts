import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'react-native-reanimated';

import { advanceTypewriterProgress, isTypewriterWriting } from '../model/typewriter';

export function useTypewriterText(targetText: string, resetKey: number | string) {
  const prefersReducedMotion = useReducedMotion();
  const reducedMotion =
    prefersReducedMotion ||
    (typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true);
  const [revealed, setRevealed] = useState({ resetKey, length: 0 });
  const progress = useRef({ resetKey, length: 0, targetText });
  const visibleLength = reducedMotion
    ? targetText.length
    : revealed.resetKey === resetKey
      ? revealed.length
      : 0;
  const isWriting = isTypewriterWriting({ currentVisibleLength: visibleLength, targetText });

  useLayoutEffect(() => {
    const length = progress.current.resetKey === resetKey ? progress.current.length : 0;
    progress.current = {
      resetKey,
      targetText,
      length: reducedMotion ? targetText.length : Math.min(length, targetText.length),
    };
  }, [reducedMotion, resetKey, targetText]);

  useEffect(() => {
    if (!isWriting) return;
    let previousTime: number | undefined;
    let frame = requestAnimationFrame(writeFrame);

    function writeFrame(now: number) {
      const current = progress.current;
      if (current.resetKey !== resetKey) return;
      current.length = advanceTypewriterProgress({
        currentVisibleLength: current.length,
        targetText: current.targetText,
        dtMs: previousTime === undefined ? 0 : Math.min(now - previousTime, 64),
        charsPerSecond: 54,
        reducedMotion: false,
      });
      previousTime = now;
      const length = Math.floor(current.length);
      setRevealed((previous) =>
        previous.resetKey === resetKey && previous.length === length
          ? previous
          : { resetKey, length },
      );
      if (length < current.targetText.length) frame = requestAnimationFrame(writeFrame);
    }

    return () => cancelAnimationFrame(frame);
  }, [isWriting, resetKey]);

  return { visibleText: targetText.slice(0, visibleLength), isWriting };
}
