import { type ReactNode } from 'react';

import { type CatalogArchetypeId } from '@/shared/domain';

export type CanvasScreenProps = {
  readonly initialArchetypeId?: CatalogArchetypeId;
  readonly onBackToCatalog?: () => void;
  readonly onSubmitPrompt?: (prompt: string) => void;
};

export type CanvasViewProps = {
  readonly draft: string;
  readonly placeholder?: string;
  readonly canSubmit: boolean;
  readonly surfaceContent?: ReactNode;
  readonly onBackToCatalog?: () => void;
  readonly notice: string | null;
  readonly onDismissNotice: () => void;
  readonly onDraftChange: (text: string) => void;
  readonly onSubmit: () => void;
};
