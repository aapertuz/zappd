import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { CanvasScreen } from '@/features/canvas';
import { resolveRequestedArchetypeId } from '@/features/projects';

export default function AssemblyRoute() {
  const { archetypeId } = useLocalSearchParams<{ archetypeId?: string }>();
  const router = useRouter();
  const requestedId = resolveRequestedArchetypeId(archetypeId);

  if (requestedId === undefined) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.message}>Assembly unavailable</Text>
        <Link href="/" style={styles.link}>
          Back to assemblies
        </Link>
      </View>
    );
  }

  return (
    <CanvasScreen
      key={requestedId}
      initialArchetypeId={requestedId}
      onBackToCatalog={() => router.replace('/')}
    />
  );
}

const styles = StyleSheet.create({
  fallback: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#08080B',
  },
  message: {
    color: '#FAF6ED',
    fontSize: 20,
  },
  link: {
    color: '#F5C451',
  },
});
