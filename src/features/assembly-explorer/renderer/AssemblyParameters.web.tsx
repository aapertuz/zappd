import type { AssemblyParameter } from '@/shared/domain';

import classes from './AssemblyScene.web.module.css';
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
  const { isRebuildingParameters, isLoading, parameterErrorMessage } = state;
  const disabled = isLoading || isRebuildingParameters;
  return (
    <form
      className={classes.parameterForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !disabled) onApplyParameters(values);
      }}>
      {parameters.map((parameter) => {
        const { name, label, min, max, step, kind } = parameter;
        const value = values[name] ?? parameter.value;
        const formatted = formatAssemblyParameterValue(parameter, value);
        return kind === 'int' ? (
          <div key={name} className={classes.parameterRow} role="group" aria-label={label}>
            <span>{label}</span>
            <div className={classes.parameterStepper}>
              <button
                type="button"
                aria-label={`Decrease ${label}`}
                disabled={disabled || value <= min}
                onClick={() => setValue(name, Math.max(min, value - step))}>
                −
              </button>
              <output>{formatted}</output>
              <button
                type="button"
                aria-label={`Increase ${label}`}
                disabled={disabled || value >= max}
                onClick={() => setValue(name, Math.min(max, value + step))}>
                +
              </button>
            </div>
          </div>
        ) : (
          <label key={name} className={classes.dimensionRow}>
            <span>{label}</span>
            <output>{formatted}</output>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={value}
              disabled={disabled}
              aria-label={label}
              aria-valuetext={formatted}
              onChange={(event) => setValue(name, event.currentTarget.valueAsNumber)}
            />
          </label>
        );
      })}
      {parameterErrorMessage === null ? null : (
        <div className={classes.parameterError} role="alert">
          {parameterErrorMessage}
        </div>
      )}
      <button
        type="submit"
        className={classes.applyParameters}
        aria-label="Apply parameters"
        disabled={disabled || !dirty}>
        {isRebuildingParameters ? 'Rebuilding…' : 'Apply'}
      </button>
      {isRebuildingParameters ? (
        <span className={classes.visuallyHidden} role="status">
          Rebuilding assembly
        </span>
      ) : null}
    </form>
  );
}
