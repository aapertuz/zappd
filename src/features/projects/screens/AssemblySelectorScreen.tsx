import { useIsFocused, useRouter } from 'expo-router';

import { AssemblySelectorView } from '../components/AssemblySelectorView';
import { buildAssemblyRouteHref, buildCatalogAssemblyCards } from '../model/selectorState';

const cards = buildCatalogAssemblyCards();

export function AssemblySelectorScreen() {
  const router = useRouter();
  const isFocused = useIsFocused();

  return isFocused ? (
    <AssemblySelectorView
      cards={cards}
      onSelectAssembly={(archetypeId) => router.push(buildAssemblyRouteHref(archetypeId))}
    />
  ) : null;
}
