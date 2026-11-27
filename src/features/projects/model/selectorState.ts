import {
  type CatalogArchetypeId,
  OPEN_QUADRUPED_ARCHETYPE,
  PARAMETRIC_MULTIROTOR_ARCHETYPE,
  POPPY_ARCHETYPE,
  QUADCOPTER_ARCHETYPE,
  REACHY_MINI_ARCHETYPE,
  ROBOTIC_ARM_ARCHETYPE,
  ROVER_ARCHETYPE,
  getCatalogArchetypeById,
  listCatalogArchetypes,
} from '@/shared/domain';

import { type CatalogAssemblyCard, type SelectorAction, type SelectorState } from '../types';

const categories: Readonly<Record<CatalogArchetypeId, string>> = {
  [QUADCOPTER_ARCHETYPE.archetypeId]: 'Flight',
  [ROBOTIC_ARM_ARCHETYPE.archetypeId]: 'Manipulator',
  [ROVER_ARCHETYPE.archetypeId]: 'Wheeled rover',
  [OPEN_QUADRUPED_ARCHETYPE.archetypeId]: 'Quadruped',
  [PARAMETRIC_MULTIROTOR_ARCHETYPE.archetypeId]: 'Configurable flight',
  [REACHY_MINI_ARCHETYPE.archetypeId]: 'Desktop robot',
  [POPPY_ARCHETYPE.archetypeId]: 'Humanoid',
};

export function buildCatalogAssemblyCards(): readonly CatalogAssemblyCard[] {
  return listCatalogArchetypes().map(
    ({ archetypeId, commercialName, title, generationMode, semantics, nodes }) => ({
      archetypeId,
      commercialName,
      technicalTitle: title,
      partCount: nodes.length,
      category: categories[archetypeId] ?? 'Robotics',
      badge:
        semantics === 'source_inspection'
          ? 'source_inspection'
          : generationMode === 'parametric_family'
            ? 'parametric'
            : 'verified',
    }),
  );
}

export function createInitialSelectorState(): SelectorState {
  return {
    activeTurntableArchetypeId: QUADCOPTER_ARCHETYPE.archetypeId,
    visibleCardIds: [],
    reducedMotion: false,
  };
}

export function reduceSelectorState(state: SelectorState, action: SelectorAction): SelectorState {
  switch (action.type) {
    case 'activateTurntable':
      return state.activeTurntableArchetypeId === action.archetypeId
        ? state
        : { ...state, activeTurntableArchetypeId: action.archetypeId };
    case 'setVisibility':
      return {
        ...state,
        visibleCardIds: listCatalogArchetypes()
          .map(({ archetypeId }) => archetypeId)
          .filter((id) => action.changes.get(id) ?? state.visibleCardIds.includes(id)),
      };
    case 'setReducedMotion':
      return state.reducedMotion === action.reducedMotion
        ? state
        : { ...state, reducedMotion: action.reducedMotion };
  }
}

export function buildAssemblyRouteHref(archetypeId: CatalogArchetypeId): `/assemblies/${string}` {
  return `/assemblies/${encodeURIComponent(archetypeId)}`;
}

export function resolveRequestedArchetypeId(
  archetypeId: string | undefined,
): CatalogArchetypeId | undefined {
  return archetypeId === undefined ? undefined : getCatalogArchetypeById(archetypeId)?.archetypeId;
}
