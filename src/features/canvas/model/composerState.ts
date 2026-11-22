export type CanvasPromptSubmission = {
  readonly id: number;
  readonly text: string;
};

export type CanvasComposerState = {
  readonly draft: string;
  readonly lastSubmittedPrompt: CanvasPromptSubmission | null;
  readonly nextSubmissionId: number;
};

export type CanvasComposerAction =
  { readonly type: 'changeDraft'; readonly text: string } | { readonly type: 'submit' };

export const INITIAL_CANVAS_COMPOSER_STATE: CanvasComposerState = {
  draft: '',
  lastSubmittedPrompt: null,
  nextSubmissionId: 1,
};

export function normalizePromptDraft(draft: string): string {
  return draft.trim();
}

export function canSubmitPrompt(draft: string): boolean {
  return normalizePromptDraft(draft).length > 0;
}

export function reduceCanvasComposerState(
  state: CanvasComposerState,
  action: CanvasComposerAction,
): CanvasComposerState {
  switch (action.type) {
    case 'changeDraft': {
      if (action.text === state.draft) {
        return state;
      }
      return { ...state, draft: action.text };
    }
    case 'submit': {
      const normalized = normalizePromptDraft(state.draft);
      if (normalized.length === 0) {
        return state;
      }
      return {
        draft: '',
        lastSubmittedPrompt: { id: state.nextSubmissionId, text: normalized },
        nextSubmissionId: state.nextSubmissionId + 1,
      };
    }
  }
}
