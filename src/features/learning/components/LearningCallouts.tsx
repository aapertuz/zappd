import { type Ref, useEffect, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import {
  type LearningCalloutsHandle,
  type LearningCalloutsProps,
  useCalloutPresentation,
} from './calloutPresentation';
import { type LearningCalloutSlotState } from '../model/learningState';

function WritingCursor() {
  const [opacity] = useState(() => new Animated.Value(1));
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion) return;
    const blink = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.2, duration: 440, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 440, useNativeDriver: true }),
      ]),
    );
    blink.start();
    return () => blink.stop();
  }, [opacity, reducedMotion]);

  return (
    <Animated.Text accessible={false} style={[styles.cursor, { opacity }]}>
      ▍
    </Animated.Text>
  );
}

function Callout({
  slot,
  title,
  label,
  loadingText,
  onDismiss,
}: {
  readonly slot: LearningCalloutSlotState;
  readonly title: string;
  readonly label: string;
  readonly loadingText: string;
  readonly onDismiss?: () => void;
}) {
  const { body, sourceLabel, showCursor } = useCalloutPresentation(slot, loadingText);
  if (slot.kind === 'idle') return null;

  return (
    <View style={styles.card} role="status" aria-label={label}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>{title}</Text>
        {sourceLabel !== null ? <Text style={styles.source}>{sourceLabel}</Text> : null}
        {onDismiss !== undefined ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss answer"
            onPress={onDismiss}
            style={styles.dismiss}
            hitSlop={8}>
            <Text style={styles.dismissText}>×</Text>
          </Pressable>
        ) : null}
      </View>
      {slot.question !== undefined ? (
        <Text style={styles.question} numberOfLines={1}>
          {slot.question}
        </Text>
      ) : null}
      <ScrollView style={styles.scrollBody} nestedScrollEnabled>
        <Text style={styles.body}>
          {body}
          {showCursor ? <WritingCursor /> : null}
        </Text>
      </ScrollView>
    </View>
  );
}

export function LearningCallouts({
  learningState,
  explanationIsOverview,
  answeringInOverview,
  onDismissAnswer,
}: LearningCalloutsProps & { readonly ref?: Ref<LearningCalloutsHandle> }) {
  const { explanation, answer } = learningState;
  if (explanation.kind === 'idle' && answer.kind === 'idle') return null;

  return (
    <View style={styles.callouts}>
      <Callout
        title={explanationIsOverview ? 'Overview' : 'Explanation'}
        label="Component explanation"
        loadingText={
          explanationIsOverview
            ? 'Putting together a quick overview…'
            : 'Getting a simple explanation…'
        }
        slot={explanation}
      />
      <Callout
        title={
          answeringInOverview && answer.kind !== 'idle'
            ? `Answer · ${answer.componentName}`
            : 'Answer'
        }
        label="Learning answer"
        loadingText="Looking up an answer…"
        slot={answer}
        onDismiss={onDismissAnswer}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  callouts: { gap: 8 },
  card: {
    width: '100%',
    maxWidth: 400,
    gap: 6,
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: '#F5C4516B',
    borderRadius: 9,
    backgroundColor: '#12100DB8',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  eyebrow: {
    flexShrink: 1,
    color: '#F5C451',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  source: {
    paddingHorizontal: 5,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: '#F5C4513D',
    borderRadius: 999,
    color: '#E3C881',
    fontSize: 9,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  dismiss: { marginStart: 'auto', alignItems: 'center', width: 24 },
  dismissText: { color: '#F5C451', fontSize: 20 },
  question: { color: '#CFC4B0', fontSize: 12, lineHeight: 16 },
  scrollBody: { maxHeight: 88 },
  body: { color: '#FAF6ED', fontSize: 13, lineHeight: 19 },
  cursor: { color: '#F5C451' },
});
