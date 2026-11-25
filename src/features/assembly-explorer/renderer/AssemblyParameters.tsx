import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AssemblyParameter } from '@/shared/domain';

import {
  formatAssemblyParameterValue,
  useAssemblyParameterDraft,
} from '../model/parameterControls';
import type { AssemblySceneProps } from '../types';

export function AssemblyParameters({
  parameters,
  state,
  onApplyParameters,
}: Pick<AssemblySceneProps, 'state' | 'onApplyParameters'> & {
  readonly parameters: readonly AssemblyParameter[];
}) {
  const { dirty, values, setValue } = useAssemblyParameterDraft(parameters);
  const disabled = state.isLoading || state.isRebuildingParameters;
  return (
    <View accessibilityLabel="Assembly parameters" style={styles.parameters}>
      <Text style={styles.parameterText}>Parameters</Text>
      {parameters.map((parameter) => {
        const { name, label, min, max, step } = parameter;
        const value = values[name] ?? parameter.value;
        return (
          <View key={name} style={styles.parameterRow}>
            <Text style={styles.parameterText}>{label}</Text>
            <View style={styles.controls}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Decrease ${label}`}
                disabled={disabled || value <= min}
                style={styles.stepper}
                onPress={() => setValue(name, Math.max(min, value - step))}>
                <Text style={styles.parameterText}>−</Text>
              </Pressable>
              <Text style={styles.parameterText}>
                {formatAssemblyParameterValue(parameter, value)}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Increase ${label}`}
                disabled={disabled || value >= max}
                style={styles.stepper}
                onPress={() => setValue(name, Math.min(max, value + step))}>
                <Text style={styles.parameterText}>+</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
      {state.parameterErrorMessage === null ? null : (
        <Text accessibilityRole="alert" style={styles.warningText}>
          {state.parameterErrorMessage}
        </Text>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Apply parameters"
        accessibilityState={{ disabled: disabled || !dirty, busy: state.isRebuildingParameters }}
        disabled={disabled || !dirty}
        style={[styles.apply, (disabled || !dirty) && styles.disabled]}
        onPress={() => onApplyParameters(values)}>
        <Text style={styles.parameterText}>
          {state.isRebuildingParameters ? 'Rebuilding…' : 'Apply'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  parameters: {
    gap: 6,
    padding: 10,
    borderRadius: 10,
    backgroundColor: '#211b12',
  },
  parameterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  parameterText: {
    color: '#ffedbd',
    alignSelf: 'center',
    fontSize: 12,
  },
  stepper: {
    minWidth: 34,
    padding: 6,
    borderRadius: 6,
    backgroundColor: '#3c2f1b',
  },
  apply: {
    alignSelf: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
    backgroundColor: '#53401f',
  },
  disabled: {
    opacity: 0.5,
  },
  warningText: {
    color: '#f9c774',
    fontSize: 12,
  },
  controls: {
    flexDirection: 'row',
    gap: 8,
  },
});
