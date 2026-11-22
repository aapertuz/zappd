import { type ReactNode } from 'react';

export type CanvasScreenProps = {
  readonly onSubmitPrompt?: (prompt: string) => void;
};

export type CanvasViewProps = {
  readonly draft: string;
  readonly canSubmit: boolean;
  readonly surfaceContent?: ReactNode;
  readonly onDraftChange: (text: string) => void;
  readonly onSubmit: () => void;
};
