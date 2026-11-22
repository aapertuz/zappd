import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AssemblySceneProps } from '../types';

export function AssemblyScene({
  assembly,
  state,
  onSetExplodeFactor,
  onSelectComponent,
  onToggleIsolate,
}: AssemblySceneProps) {
  const parts = assembly.nodes.filter(
    (node) => node.level === 'component' || node.level === 'subcomponent',
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{assembly.title}</Text>
      <Text style={styles.subtitle}>
        {assembly.verificationStatus} · Explode {Math.round(state.explodeFactor * 100)}%
      </Text>
      <View style={styles.controls}>
        <Pressable style={styles.button} onPress={() => onSetExplodeFactor(0)}>
          <Text style={styles.buttonText}>Collapse</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={() => onSetExplodeFactor(1)}>
          <Text style={styles.buttonText}>Explode 100%</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={onToggleIsolate}>
          <Text style={styles.buttonText}>
            {state.isolatedComponentId !== null ? 'Show All' : 'Isolate'}
          </Text>
        </Pressable>
      </View>
      <View style={styles.list}>
        {parts.map((part) => (
          <Pressable
            key={part.id}
            style={styles.partRow}
            onPress={() => onSelectComponent(part.id)}>
            <Text style={styles.partName}>{part.name}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    gap: 10,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: '#18181b',
  },
  subtitle: {
    fontSize: 13,
    color: '#52525b',
  },
  controls: {
    flexDirection: 'row',
    gap: 8,
  },
  button: {
    backgroundColor: '#ffe500',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  buttonText: {
    color: '#18181b',
    fontWeight: '600',
    fontSize: 12,
  },
  list: {
    gap: 6,
  },
  partRow: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e5e5e0',
  },
  partName: {
    color: '#18181b',
    fontSize: 13,
  },
});
