import { useState } from 'react';

import type { AssemblyParameter, ValidationReport } from '@/shared/domain';

export function formatAssemblyParameterValue(parameter: AssemblyParameter, value: number): string {
  return parameter.unit === 'mm'
    ? `${value} mm`
    : parameter.unit === 'deg'
      ? `${value}°`
      : String(value);
}

export function useAssemblyParameterDraft(parameters: readonly AssemblyParameter[]) {
  const [draftState, setDraftState] = useState<{
    readonly parameters: readonly AssemblyParameter[];
    readonly values: Readonly<Record<string, number>>;
  }>({ parameters, values: {} });
  const draft = draftState.parameters === parameters ? draftState.values : {};
  if (draftState.parameters !== parameters) {
    setDraftState({ parameters, values: {} });
  }
  return {
    dirty: parameters.some(({ name, value }) => (draft[name] ?? value) !== value),
    values: Object.fromEntries(parameters.map(({ name, value }) => [name, draft[name] ?? value])),
    setValue: (name: string, value: number) =>
      setDraftState((current) => ({
        parameters,
        values: {
          ...(current.parameters === parameters ? current.values : {}),
          [name]: value,
        },
      })),
  };
}

export function getAssemblyValidationFailures({
  failures,
  electricalFailures = [],
  floatingComponentIds = [],
}: ValidationReport): readonly string[] {
  return [
    ...new Set([
      ...failures,
      ...electricalFailures,
      ...floatingComponentIds.map((id) => `Floating component ${id}`),
    ]),
  ];
}
