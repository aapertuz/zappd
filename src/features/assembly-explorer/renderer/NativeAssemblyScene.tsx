import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { LearningCallouts } from '@/features/learning';

import { type AssemblySceneProps } from '../types';

export function NativeAssemblyScene({
  assembly,
  state,
  onSetExplodeFactor,
  onFocusComponent,
  onExitPartFocus,
  learningState,
  onDismissLearningAnswer,
  onToggleIsolate,
}: AssemblySceneProps) {
  const parts = assembly.nodes.filter(
    (node) => node.level === 'component' || node.level === 'subcomponent',
  );

  const focusedId = state.viewMode.kind === 'part_focus' ? state.viewMode.componentId : null;
  const focusedPart = parts.find(({ id }) => id === focusedId);
  const canShowAnswer =
    learningState.answer.kind === 'idle' ||
    focusedId === null ||
    learningState.answer.componentId === focusedId;

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
      {focusedPart !== undefined ? (
        <View style={styles.controls}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={styles.button}
            onPress={onExitPartFocus}>
            <Text style={styles.buttonText}>Back</Text>
          </Pressable>
          <Text accessibilityLabel="Focused component" style={styles.partName}>
            {focusedPart.name}
          </Text>
        </View>
      ) : null}
      <LearningCallouts
        learningState={
          canShowAnswer ? learningState : { ...learningState, answer: { kind: 'idle' } }
        }
        explanationIsOverview={focusedId === null}
        answeringInOverview={focusedId === null}
        onDismissAnswer={onDismissLearningAnswer}
      />
      <ScrollView contentContainerStyle={styles.list}>
        {parts.map((part) => (
          <Pressable
            key={part.id}
            style={styles.partRow}
            accessibilityRole="button"
            onPress={() => onFocusComponent(part.id)}>
            <Text style={styles.partName}>{part.name}</Text>
          </Pressable>
        ))}
      </ScrollView>
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
