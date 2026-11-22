import { type FormEvent, type KeyboardEvent, useEffect, useRef } from 'react';

import { type CanvasViewProps } from '../types';
import classes from './CanvasView.module.css';

export function CanvasView({ draft, canSubmit, onDraftChange, onSubmit }: CanvasViewProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft]);

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSubmit) onSubmit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSubmit) onSubmit();
  }

  return (
    <main className={classes.canvas}>
      <div className={classes.surface} />
      <div className={classes.composerDock}>
        <form className={classes.composer} onSubmit={handleFormSubmit}>
          <textarea
            ref={textareaRef}
            className={classes.input}
            rows={1}
            aria-label="Prompt input"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            type="submit"
            className={classes.sendButton}
            disabled={!canSubmit}
            aria-label="Send">
            <svg
              className={classes.sendIcon}
              width={20}
              height={20}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true">
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </button>
        </form>
      </div>
    </main>
  );
}
