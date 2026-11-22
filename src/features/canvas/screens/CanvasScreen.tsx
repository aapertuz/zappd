import { useReducer } from 'react';

import { CanvasView } from '../components/CanvasView';
import {
  INITIAL_CANVAS_COMPOSER_STATE,
  canSubmitPrompt,
  normalizePromptDraft,
  reduceCanvasComposerState,
} from '../model/composerState';
import { type CanvasScreenProps } from '../types';

export function CanvasScreen({ onSubmitPrompt }: CanvasScreenProps) {
  const [state, dispatch] = useReducer(reduceCanvasComposerState, INITIAL_CANVAS_COMPOSER_STATE);
  const canSubmit = canSubmitPrompt(state.draft);

  function handleDraftChange(text: string) {
    dispatch({ type: 'changeDraft', text });
  }

  function handleSubmit() {
    const normalized = normalizePromptDraft(state.draft);
    if (normalized.length === 0) return;
    dispatch({ type: 'submit' });
    onSubmitPrompt?.(normalized);
  }

  return (
    <CanvasView
      draft={state.draft}
      canSubmit={canSubmit}
      onDraftChange={handleDraftChange}
      onSubmit={handleSubmit}
    />
  );
}
