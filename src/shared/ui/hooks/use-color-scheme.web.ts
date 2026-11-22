import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

const subscribeToNoopStore = () => () => {};

export function useColorScheme() {
  const isHydratedOnClient = useSyncExternalStore(
    subscribeToNoopStore,
    () => true,
    () => false,
  );

  const colorScheme = useRNColorScheme();

  if (isHydratedOnClient) {
    return colorScheme;
  }

  return 'light';
}
