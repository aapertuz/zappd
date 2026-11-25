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
  const [draft, setDraft] = useState<Readonly<Record<string, number>>>({});
  return {
    dirty: parameters.some(({ name, value }) => (draft[name] ?? value) !== value),
    values: Object.fromEntries(parameters.map(({ name, value }) => [name, draft[name] ?? value])),
    setValue: (name: string, value: number) =>
      setDraft((current) => ({ ...current, [name]: value })),
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
