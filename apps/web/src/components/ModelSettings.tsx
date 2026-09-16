import { textInputProps } from "../textInputProps";
import { useEffect, useState } from "react";
import { apiPath } from "../api";
import { useI18n } from "../i18n";
import { CheckIcon, CloseIcon, EditIcon, FlaskIcon, PlusIcon, SpinnerIcon } from "./icons";

/** The wire format Termany speaks to this provider — also the stored kind. */
type Kind = "anthropic" | "openai";

/** A provider as held in local edit state (apiKey starts as the masked value). */
interface Provider {
  id: string;
  name: string;
  apiBase: string;
  apiKey: string;
  models: string[];
  kind: Kind;
  hasKey: boolean;
}

interface Draft {
  id: string;
  preset: string;
  name: string;
  apiBase: string;
  apiKey: string;
  modelsText: string;
  kind: Kind;
  /** True when editing a row that already exists in the list. */
  editing: boolean;
  /** True only when the server holds a key for this id — i.e. blank really can
   *  mean "keep the current one". A row added locally has nothing stored yet. */
  hasStoredKey: boolean;
}

interface TestState {
  running: boolean;
  ok?: boolean;
  error?: string;
  model?: string;
}

/**
 * Vendor presets: picking one fills in the wire format, base URL and a starter
 * model, so the common providers are two clicks instead of three URLs looked
 * up. "custom" keeps whatever the user already typed.
 */
const PRESETS: Array<{ id: string; label: string; kind: Kind; apiBase: string; model: string }> = [
  { id: "anthropic", label: "Anthropic", kind: "anthropic", apiBase: "https://api.anthropic.com", model: "claude-opus-4-8" },
  { id: "openai", label: "OpenAI", kind: "openai", apiBase: "https://api.openai.com/v1", model: "gpt-5.6-sol" },
  { id: "openrouter", label: "OpenRouter", kind: "openai", apiBase: "https://openrouter.ai/api", model: "xiaomi/mimo-v2.5" },
  { id: "deepseek", label: "DeepSeek", kind: "openai", apiBase: "https://api.deepseek.com", model: "deepseek-v4-flash" },
  { id: "minimax", label: "MiniMax", kind: "anthropic", apiBase: "https://api.minimax.io/anthropic", model: "MiniMax-M3" },
  { id: "glm", label: "GLM Coding Plan", kind: "anthropic", apiBase: "https://api.z.ai/api/anthropic", model: "GLM-5.2" },
  { id: "custom", label: "Custom", kind: "openai", apiBase: "", model: "" },
];

const DEFAULT_BASE: Record<Kind, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
};

const newId = () => crypto.randomUUID();

/** Mirrors the server's joinUrl so the dialog can preview the tested endpoint. */
function testEndpoint(apiBase: string, kind: Kind): string {
  const base = (apiBase.trim() || DEFAULT_BASE[kind]).replace(/\/+$/, "");
  const endpoint = kind === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  if (base.endsWith(endpoint)) return base;
  if (base.endsWith("/v1")) return base + endpoint.slice("/v1".length);
  return base + endpoint;
}

/** Model-provider settings — BYOK: the user adds their own Anthropic or
 *  OpenAI-compatible providers with their own API key. No managed built-in. */
export function ModelSettings() {
  const { t } = useI18n();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Provider | null>(null);
  const [test, setTest] = useState<TestState>({ running: false });
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(apiPath("/api/models"))
      .then((r) => r.json())
      .then((cfg) => {
        setProviders(
          cfg.providers.map((p: any) => ({
            id: p.id,
            name: p.name,
            apiBase: p.apiBase,
            apiKey: p.keyMask ?? "", // masked; server treats unchanged-masked as "keep"
            models: p.models,
            kind: p.kind === "anthropic" ? "anthropic" : "openai",
            hasKey: p.hasKey,
          }))
        );
        setDefaultModel(cfg.defaultModel);
      })
      .catch((e) => setStatus(t("models.loadFailed", { error: e.message })));
  }, []);

  const modelOptions = providers.flatMap((p) =>
    p.models.map((m) => ({ value: `${p.id}/${m}`, label: `${p.name} / ${m}` }))
  );

  function openEdit(p: Provider) {
    setTest({ running: false });
    setDraft({
      id: p.id,
      // An existing row has no recorded preset. Match on base URL, or — for the
      // rows saved before presets existed, which left the base blank to mean
      // "the official endpoint" — on the wire format.
      preset:
        (p.apiBase
          ? PRESETS.find((x) => x.apiBase === p.apiBase.replace(/\/+$/, ""))
          : PRESETS.find((x) => x.kind === p.kind)
        )?.id ?? "custom",
      name: p.name,
      apiBase: p.apiBase,
      apiKey: "",
      modelsText: p.models.join("\n"),
      kind: p.kind,
      editing: true,
      hasStoredKey: p.hasKey,
    });
  }

  function openAdd() {
    setTest({ running: false });
    // Default to Anthropic — the AI features are Claude-first.
    const preset = PRESETS[0];
    setDraft({
      id: newId(),
      preset: preset.id,
      name: preset.label,
      apiBase: preset.apiBase,
      apiKey: "",
      modelsText: preset.model,
      kind: preset.kind,
      editing: false,
      hasStoredKey: false,
    });
  }

  /** Picking a vendor rewrites the fields it owns; "custom" only clears them. */
  function applyPreset(id: string) {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset || !draft) return;
    setTest({ running: false });
    setDraft({
      ...draft,
      preset: id,
      kind: preset.kind,
      // Custom is the escape hatch: keep whatever the user typed.
      name: id === "custom" ? draft.name : preset.label,
      apiBase: id === "custom" ? draft.apiBase : preset.apiBase,
      modelsText: id === "custom" ? draft.modelsText : preset.model,
    });
  }

  const draftModels = (d: Draft) =>
    d.modelsText
      .split(/[\n,]/)
      .map((m) => m.trim())
      .filter(Boolean);

  async function runTest() {
    if (!draft) return;
    // Blank + nothing stored server-side would fail upstream with a generic
    // message; say plainly that this provider has no saved key to fall back on.
    if (!draft.apiKey.trim() && !draft.hasStoredKey) {
      setTest({ running: false, ok: false, error: t("models.test.needKey") });
      return;
    }
    setTest({ running: true });
    try {
      const res = await fetch(apiPath("/api/models/test"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: draft.kind,
          apiBase: draft.apiBase,
          apiKey: draft.apiKey,
          model: draftModels(draft)[0] ?? "",
          // Lets the server fall back to the stored key — only meaningful when
          // one is actually stored.
          providerId: draft.hasStoredKey ? draft.id : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
      setTest({ running: false, ok: data.ok, error: data.error, model: data.model });
    } catch (e) {
      setTest({ running: false, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function saveDraft() {
    if (!draft) return;
    const models = draftModels(draft);
    const next: Provider = {
      id: draft.id,
      name: draft.name.trim() || (draft.kind === "anthropic" ? "Anthropic" : "Provider"),
      apiBase: draft.apiBase.trim(),
      apiKey: draft.apiKey, // typed key, or "" to keep the stored one
      models,
      kind: draft.kind,
      hasKey: draft.hasStoredKey,
    };
    const i = providers.findIndex((p) => p.id === next.id);
    const list =
      i >= 0
        ? providers.map((p, idx) =>
            // A blank key on an edit means "keep": send the mask back, which
            // the server reads as unchanged.
            idx === i ? { ...next, apiKey: draft.apiKey || p.apiKey } : p
          )
        : [next, ...providers];
    // Adopting the first model of a first provider saves a second trip through
    // the default-model select.
    const nextDefault = defaultModel || (models[0] ? `${next.id}/${models[0]}` : "");
    if (await persist(list, nextDefault)) setDraft(null);
  }

  async function confirmRemove() {
    if (!deleting) return;
    const list = providers.filter((p) => p.id !== deleting.id);
    // Drop the default too if it pointed into the provider being removed;
    // the server would otherwise re-pick one silently.
    const nextDefault = defaultModel.startsWith(`${deleting.id}/`) ? "" : defaultModel;
    if (await persist(list, nextDefault)) setDeleting(null);
  }

  /**
   * The single write path: persist the given list + default selection, then
   * adopt the server's view (masks, hasKey, a corrected default). Every
   * mutation flows through here, so the panel is never out of sync with disk.
   */
  async function persist(nextProviders: Provider[], nextDefault: string): Promise<boolean> {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch(apiPath("/api/models"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultModel: nextDefault,
          providers: nextProviders.map((p) => ({
            id: p.id,
            name: p.name,
            apiBase: p.apiBase,
            apiKey: p.apiKey, // masked/"" → server keeps stored key
            models: p.models,
            kind: p.kind,
          })),
        }),
      });
      const cfg = await res.json();
      if (!res.ok) throw new Error(cfg.error ?? `request failed (${res.status})`);
      setProviders(
        cfg.providers.map((p: any) => ({
          id: p.id,
          name: p.name,
          apiBase: p.apiBase,
          apiKey: p.keyMask ?? "",
          models: p.models,
          kind: p.kind === "anthropic" ? "anthropic" : "openai",
          hasKey: p.hasKey,
        }))
      );
      setDefaultModel(cfg.defaultModel);
      setStatus(t("models.saved"));
      window.dispatchEvent(new Event("termany:models-changed"));
      return true;
    } catch (e) {
      setStatus(t("models.saveFailed", { error: e instanceof Error ? e.message : String(e) }));
      return false;
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="ms-head">
        <div className="settings-section-title">{t("models.title")}</div>
        <div className="ms-head-actions">
          <button className="ms-btn" onClick={openAdd} disabled={saving}>
            <PlusIcon /> {t("models.addProvider")}
          </button>
        </div>
      </div>

      <div className="ms-card">
        <div className="ms-card-title">{t("models.defaultModel")}</div>
        <select
          className="ms-select"
          value={defaultModel}
          disabled={modelOptions.length === 0}
          onChange={(e) => {
            setDefaultModel(e.target.value);
            void persist(providers, e.target.value);
          }}
        >
          {modelOptions.length === 0 ? (
            <option value="">{t("models.noProviders")}</option>
          ) : (
            modelOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))
          )}
        </select>
        <div className="ms-hint">{t("models.byokHint")}</div>
      </div>

      <div className="ms-table-scroll">
        <table className="ms-table">
        <thead>
          <tr>
            <th>{t("models.col.name")}</th>
            <th>{t("models.col.type")}</th>
            <th>{t("models.col.apiBase")}</th>
            <th>{t("models.col.models")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {providers.length === 0 && (
            <tr>
              <td colSpan={5} className="ms-empty">
                {t("models.empty")}
              </td>
            </tr>
          )}
          {providers.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{t(p.kind === "anthropic" ? "models.kind.anthropic" : "models.kind.openai")}</td>
              <td>
                <code className="ms-mono">{p.apiBase || DEFAULT_BASE[p.kind]}</code>
              </td>
              <td>{p.models.length}</td>
              <td className="ms-actions">
                <button className="ms-icon" title={t("models.edit")} onClick={() => openEdit(p)}>
                  <EditIcon />
                </button>
                <button className="ms-icon" title={t("models.delete")} onClick={() => setDeleting(p)}>
                  <CloseIcon />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
        </table>
      </div>

      {status && <div className="ms-status">{status}</div>}

      {deleting && (
        <div className="ms-form-backdrop" onClick={() => setDeleting(null)}>
          <div className="ws-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="quit-confirm-text">
              {t("models.deleteConfirm", { name: deleting.name })}
            </p>
            <div className="ws-dialog-actions">
              <button className="ws-dialog-btn" onClick={() => setDeleting(null)} disabled={saving}>
                {t("models.form.cancel")}
              </button>
              <button
                className="ws-dialog-btn danger"
                autoFocus
                onClick={() => void confirmRemove()}
                disabled={saving}
              >
                {t("models.delete")}
              </button>
            </div>
          </div>
        </div>
      )}

      {draft && (
        <div className="ms-form-backdrop" onClick={() => setDraft(null)}>
          <div className="ms-form" onClick={(e) => e.stopPropagation()}>
            <div className="ms-form-title">
              {t(draft.editing ? "models.form.editTitle" : "models.form.createTitle")}
            </div>
            <div className="ms-form-sub">
              {t(draft.editing ? "models.form.editSub" : "models.form.createSub")}
            </div>

            <div className="ms-field-row">
              <label className="ms-field">
                <span>{t("models.form.providerType")}</span>
                <select value={draft.preset} onChange={(e) => applyPreset(e.target.value)}>
                  {PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id === "custom" ? t("models.preset.custom") : p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ms-field">
                <span>{t("models.form.apiType")}</span>
                <select
                  value={draft.kind}
                  onChange={(e) => {
                    setTest({ running: false });
                    setDraft({ ...draft, kind: e.target.value as Kind });
                  }}
                >
                  <option value="anthropic">{t("models.kind.anthropic")}</option>
                  <option value="openai">{t("models.kind.openai")}</option>
                </select>
              </label>
            </div>

            <label className="ms-field">
              <span>{t("models.form.name")}</span>
              <input
                {...textInputProps}
                value={draft.name}
                placeholder={t("models.form.namePlaceholder")}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="ms-field">
              <span>{t("models.form.apiBase")}</span>
              <input
                {...textInputProps}
                value={draft.apiBase}
                placeholder={DEFAULT_BASE[draft.kind]}
                onChange={(e) => {
                  setTest({ running: false });
                  setDraft({ ...draft, apiBase: e.target.value });
                }}
              />
            </label>
            <label className="ms-field">
              <span>{t("models.form.apiKey")}</span>
              <input
                {...textInputProps}
                type="password"
                value={draft.apiKey}
                placeholder={t(draft.hasStoredKey ? "models.form.keyKeep" : "models.form.keyPlaceholder")}
                onChange={(e) => {
                  setTest({ running: false });
                  setDraft({ ...draft, apiKey: e.target.value });
                }}
              />
            </label>
            <label className="ms-field">
              <span>{t("models.form.models")}</span>
              <textarea
                {...textInputProps}
                rows={3}
                value={draft.modelsText}
                placeholder={draft.kind === "anthropic" ? "claude-opus-4-8" : "deepseek-chat"}
                onChange={(e) => {
                  setTest({ running: false });
                  setDraft({ ...draft, modelsText: e.target.value });
                }}
              />
            </label>

            <div className="ms-form-note">{t("models.form.testNote")}</div>
            <div className="ms-form-note">
              {t("models.form.testEndpoint")}{" "}
              <code className="ms-mono">{testEndpoint(draft.apiBase, draft.kind)}</code>
            </div>

            {test.ok !== undefined && !test.running && (
              <div className="ms-test-result">
                {test.ok ? (
                  <span className="ms-test-ok">
                    <CheckIcon /> {t("models.test.passed")}
                    {test.model ? ` · ${test.model}` : ""}
                  </span>
                ) : (
                  <span className="ms-test-fail">{test.error || t("models.test.failed")}</span>
                )}
              </div>
            )}

            <div className="ms-form-actions">
              <button
                className="ms-btn"
                onClick={() => void runTest()}
                disabled={test.running || draftModels(draft).length === 0}
              >
                {test.running ? <SpinnerIcon /> : <FlaskIcon />}
                {test.running ? t("models.test.running") : t("models.test.run")}
              </button>
              <button className="ms-btn" onClick={() => setDraft(null)} disabled={saving}>
                {t("models.form.cancel")}
              </button>
              <button className="ms-btn primary" onClick={() => void saveDraft()} disabled={saving}>
                {saving ? t("models.saving") : t("models.form.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
