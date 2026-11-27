import { type CatalogArchetypeId } from '@/shared/domain';

export type AssemblyBadgeKind = 'verified' | 'parametric' | 'source_inspection';

export type CatalogAssemblyCard = {
  readonly archetypeId: CatalogArchetypeId;
  readonly commercialName: string;
  readonly technicalTitle: string;
  readonly partCount: number;
  readonly category: string;
  readonly badge: AssemblyBadgeKind;
};

export type SelectorState = {
  readonly activeTurntableArchetypeId: CatalogArchetypeId;
  readonly visibleCardIds: readonly CatalogArchetypeId[];
  readonly reducedMotion: boolean;
};

export type SelectorAction =
  | { readonly type: 'activateTurntable'; readonly archetypeId: CatalogArchetypeId }
  | { readonly type: 'setVisibility'; readonly changes: ReadonlyMap<CatalogArchetypeId, boolean> }
  | { readonly type: 'setReducedMotion'; readonly reducedMotion: boolean };

export type AssemblySelectorViewProps = {
  readonly cards: readonly CatalogAssemblyCard[];
  readonly onSelectAssembly: (archetypeId: CatalogArchetypeId) => void;
};
