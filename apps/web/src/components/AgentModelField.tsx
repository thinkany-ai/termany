import { useId } from "react";
import { modelSelectItems, type ModelMenuItem } from "../agentModelMenu";
import { useI18n } from "../i18n";
import { ChevronIcon } from "./icons";

/** Settings presentation of the same model state used by the composer. */
export function AgentModelField({ label, value, choices, fallbackLabel, busy, disabled, error, onChange, onRetry }: {
  label?: string;
  value: string;
  choices: ModelMenuItem[];
  fallbackLabel: string;
  busy: boolean;
  disabled: boolean;
  error: "load" | "save" | null;
  onChange: (value: string) => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const errorId = useId();
  const values = modelSelectItems(choices);
  return (
    <div className="agent-setting-field agent-model-field">
      <label>
        <span>{label ?? t("agentWorkspace.model")}</span>
        <span className="agent-model-select">
          <select
            autoComplete="off"
            value={value}
            disabled={disabled || busy || values.length === 0}
            aria-busy={busy}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => onChange(event.target.value)}
          >
            {!values.some((choice) => choice.id === value) && (
              <option value={value} disabled>{fallbackLabel}</option>
            )}
            {values.map((choice) => (
              <option key={choice.id} value={choice.id}>{choice.label}</option>
            ))}
          </select>
          <ChevronIcon dir="down" />
        </span>
      </label>
      {error && (
        <div className="agent-model-field-error">
          <span id={errorId} role="alert">
            {t(error === "save" ? "agentWorkspace.modelSaveError" : "agentWorkspace.modelLoadError")}
          </span>
          {error === "load" && (
            <button type="button" disabled={disabled || busy} onClick={onRetry}>
              {t("agentWorkspace.retryModels")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
