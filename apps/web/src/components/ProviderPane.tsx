import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Network, Pencil, Plus, RefreshCw, Trash2, Unplug, Waypoints } from "lucide-react";
import { writeClipboard } from "../clipboard";
import { useI18n } from "../i18n";
import { fetchConnection, fetchGateway, routeAction, saveRoute, type GatewayRoute, type GatewayState, type RouteDraft } from "../modelGateway";
import { textInputProps } from "../textInputProps";
import { SpinnerIcon } from "./icons";
import { GatewayAgentLogo, GatewayAgentSelect } from "./GatewayAgentSelect";

const manageModels = () => window.dispatchEvent(new CustomEvent("termany:open-settings", { detail: "models" }));
const manageAgents = () => window.dispatchEvent(new CustomEvent("termany:open-settings", { detail: "agents" }));
const newDraft = (state: GatewayState | null): RouteDraft => {
  const agent = state?.agents[0];
  return { name: agent?.name ?? "", agent: agent?.id ?? "", protocol: agent?.id === "claude" ? "anthropic" : "openai", mode: "auto", providerId: "", model: "" };
};

/** Keep the persisted pane kind stable so existing layouts open the gateway. */
export function ProviderPane() {
  const { t } = useI18n();
  const [state, setState] = useState<GatewayState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<RouteDraft | null>(null);
  const [confirm, setConfirm] = useState<{ route: GatewayRoute; action: "delete" | "disconnect" | "connect" } | null>(null);
  const [connection, setConnection] = useState<{ name: string; baseUrl: string; apiKey: string } | null>(null);
  const [copied, setCopied] = useState("");
  const generation = useRef(0);
  const locked = useRef(false);

  const refresh = useCallback(async () => {
    if (locked.current) return;
    const version = ++generation.current;
    try {
      const next = await fetchGateway();
      if (version === generation.current) { setState(next); setError(""); }
    } catch (e) { if (version === generation.current) setError((e as Error).message); }
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener("termany:models-changed", onFocus);
    window.addEventListener("termany:agents-saved", onFocus);
    window.addEventListener("termany:agents-changed", onFocus);
    return () => { ++generation.current; window.removeEventListener("focus", onFocus); window.removeEventListener("termany:models-changed", onFocus); window.removeEventListener("termany:agents-saved", onFocus); window.removeEventListener("termany:agents-changed", onFocus); };
  }, [refresh]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(""), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !locked.current) { setDraft(null); setConfirm(null); setConnection(null); }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);

  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    ++generation.current;
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { locked.current = false; setBusy(false); }
  }
  async function copy(value: string, key: string) {
    if (await writeClipboard(value)) setCopied(key);
    else setError(t("gateway.copyFailed"));
  }
  const agents = state?.agents ?? [];
  const selectedAgent = agents.find((agent) => agent.id === draft?.agent);
  const legacyAgent = Boolean(draft?.id && draft.agent === "custom");
  const providers = state?.providers ?? [];
  const selected = providers.find((p) => p.id === draft?.providerId);
  const validDraft = draft && (selectedAgent || legacyAgent) && draft.name.trim() && providers.some((p) => p.models.length > 0) &&
    (draft.mode === "auto" || (selected && selected.models.length > 0 && selected.models.includes(draft.model)));
  const modal = Boolean(draft || confirm || connection);

  return (
    <div className="provider-pane gateway-pane">
      <div className="provider-pane-header">
        <span className="provider-pane-title">{t("gateway.title")}</span>
        <button className="ms-icon gateway-refresh" disabled={busy} title={t("gateway.refresh")} aria-label={t("gateway.refresh")} onClick={() => void refresh()}><RefreshCw size={15} /></button>
      </div>
      <div className="gateway-body">
        <div className="gateway-toolbar">
          <div className="gateway-rules-title"><h2>{t("gateway.rules")}</h2>{state && <span>{state.routes.length}</span>}</div>
          <div className="gateway-toolbar-actions">
            <button className="ms-btn primary" disabled={!state || busy} onClick={() => { setError(""); setDraft(newDraft(state)); }}><Plus size={15} />{t("gateway.addRoute")}</button>
          </div>
        </div>
        <div className="gateway-table-scroll">
          <table className="gateway-table">
            <thead><tr><th>{t("gateway.agent")}</th><th>{t("gateway.destination")}</th><th>{t("gateway.routing")}</th><th>{t("gateway.status")}</th><th aria-label={t("gateway.actions")}></th></tr></thead>
            <tbody>
              {!state && <tr><td colSpan={5} className="gateway-empty">{error || <SpinnerIcon />}</td></tr>}
              {state?.routes.length === 0 && <tr><td colSpan={5}><div className="gateway-empty"><Waypoints size={30} /><strong>{t("gateway.emptyTitle")}</strong><p>{t("gateway.emptyHint")}</p><button className="ms-btn" onClick={() => setDraft(newDraft(state))}><Plus size={14} />{t("gateway.addRoute")}</button></div></td></tr>}
              {state?.routes.map((route) => {
                const provider = state.providers.find((p) => p.id === route.providerId);
                return <tr key={route.id}>
                  <td><div className="gateway-agent"><span className="gateway-agent-icon"><GatewayAgentLogo agent={agents.find((agent) => agent.id === route.agent)} id={route.agent} /></span><div><strong>{route.name}</strong><small>{route.protocol === "anthropic" ? "Anthropic Messages" : route.agent === "codex" ? "OpenAI Responses" : "OpenAI API"}</small></div></div></td>
                  <td><div className="gateway-target"><span>{route.mode === "auto" ? t("gateway.compatibleProviders") : provider?.name ?? t("gateway.missingProvider")}</span><small>{route.mode === "auto" ? t("gateway.matchThenDefault") : route.model || t("gateway.requestedModel")}</small></div></td>
                  <td><span className={`gateway-mode ${route.mode}`}><Waypoints size={13} />{t(route.mode === "auto" ? "gateway.auto" : "gateway.fixed")}</span></td>
                  <td><span className={`gateway-status ${route.issue || route.drifted || route.agentMissing ? "warning" : route.connected ? "connected" : ""}`} title={route.issue || (route.drifted ? t("gateway.driftedHint") : undefined)}>{t(route.agentMissing ? "gateway.agentUnavailable" : route.issue ? "gateway.needsModel" : route.drifted ? "gateway.drifted" : route.connected ? "gateway.connected" : !route.canConnect ? "gateway.manual" : "gateway.ready")}</span></td>
                  <td><div className="gateway-row-actions">
                    {route.canConnect && !route.connected && <button className="ms-btn" disabled={busy || !!route.issue} onClick={() => setConfirm({ route, action: "connect" })}>{t("gateway.connect")}</button>}
                    {route.connected && <button className="ms-icon" disabled={busy} title={t("gateway.disconnect")} aria-label={`${t("gateway.disconnect")}: ${route.name}`} onClick={() => setConfirm({ route, action: "disconnect" })}><Unplug size={15} /></button>}
                    <button className="ms-icon" disabled={busy} title={t("gateway.connection")} aria-label={`${t("gateway.connection")}: ${route.name}`} onClick={() => void run(async () => setConnection({ name: route.name, ...await fetchConnection(route.id) }))}><Network size={15} /></button>
                    <button className="ms-icon" disabled={busy} title={t("gateway.editRoute")} aria-label={`${t("gateway.editRoute")}: ${route.name}`} onClick={() => { setError(""); setDraft({ ...route, model: route.model ? (provider?.models.includes(route.model) ? route.model : "") : provider?.models[0] ?? "" }); }}><Pencil size={15} /></button>
                    <button className="ms-icon" disabled={busy} title={t("gateway.deleteRoute")} aria-label={`${t("gateway.deleteRoute")}: ${route.name}`} onClick={() => setConfirm({ route, action: "delete" })}><Trash2 size={15} /></button>
                  </div></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
        {error && !modal && <div className="provider-error" role="alert">{error}</div>}
      </div>

      {modal && <div className="ms-form-backdrop" onClick={() => { if (!busy) { setDraft(null); setConfirm(null); setConnection(null); } }}>
        <div className="ms-form gateway-form" role="dialog" aria-modal="true" aria-labelledby="gateway-dialog-title" onClick={(e) => e.stopPropagation()}>
          <h2 id="gateway-dialog-title" className="ms-form-title">{draft ? t(draft.id ? "gateway.editRoute" : "gateway.addRoute") : connection ? connection.name : t(`gateway.${confirm!.action}Title`)}</h2>
          {draft && <form onSubmit={(e) => { e.preventDefault(); if (validDraft) void run(async () => { setState(await saveRoute(draft)); setDraft(null); }); }}>
            <div className="ms-field-row">
              <div className="ms-field"><span>{t("gateway.agentType")}</span><GatewayAgentSelect agents={agents} label={t("gateway.agentType")}
                placeholder={t("gateway.chooseAgent")} unavailable={t(legacyAgent ? "gateway.customAgent" : "gateway.agentUnavailable")}
                disabled={Boolean(draft.id && state?.routes.find((r) => r.id === draft.id)?.connected)} value={draft.agent}
                onChange={(agent) => setDraft({ ...draft, agent: agent.id, name: agent.name, protocol: agent.id === "claude" ? "anthropic" : ["codex", "hermes"].includes(agent.id) ? "openai" : draft.protocol })} /></div>
              <label className="ms-field"><span>{t("gateway.agentName")}</span><input {...textInputProps} required autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("gateway.namePlaceholder")} /></label>
            </div>
            {!selectedAgent?.canConnect && <label className="ms-field"><span>{t("gateway.protocol")}</span><select value={draft.protocol} onChange={(e) => setDraft({ ...draft, protocol: e.target.value as RouteDraft["protocol"] })}><option value="openai">OpenAI API</option><option value="anthropic">Anthropic Messages</option></select></label>}
            <fieldset className="gateway-mode-picker"><legend>{t("gateway.routing")}</legend>{(["auto", "provider"] as const).map((mode) => <label key={mode} className={draft.mode === mode ? "selected" : ""}><input type="radio" name="gateway-mode" value={mode} checked={draft.mode === mode} onChange={() => setDraft({ ...draft, mode })} /><span><strong>{t(mode === "auto" ? "gateway.auto" : "gateway.fixed")}</strong><small>{t(mode === "auto" ? "gateway.autoDescription" : "gateway.fixedDescription")}</small></span></label>)}</fieldset>
            {draft.mode === "provider" && <div className="ms-field-row">
              <label className="ms-field"><span>{t("gateway.provider")}</span>
                <select aria-label={t("gateway.provider")} value={draft.providerId} onChange={(e) => setDraft({ ...draft, providerId: e.target.value, model: providers.find((provider) => provider.id === e.target.value)?.models[0] ?? "" })}>
                  <option value="">{t("gateway.chooseProvider")}</option>
                  {draft.providerId && !selected && <option value={draft.providerId}>{t("gateway.missingProvider")}</option>}
                  {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                </select>
              </label>
              <label className="ms-field"><span>{t("gateway.model")}</span>
                <select aria-label={t("gateway.model")} disabled={!selected?.models.length} value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })}>
                  <option value="" disabled hidden>{t("gateway.chooseModel")}</option>
                  {selected?.models.map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              </label>
            </div>}
            {(!providers.some((p) => p.models.length > 0) || (draft.mode === "provider" && selected && !selected.models.length)) && <div className="gateway-no-models"><p>{t("gateway.noCompatibleModels")}</p></div>}
            <p className="ms-form-note">{t(!selectedAgent?.canConnect ? "gateway.customHint" : draft.agent === "codex" ? "gateway.codexHint" : draft.id && state?.routes.find((route) => route.id === draft.id)?.connected ? (draft.agent === "hermes" ? "gateway.hermesModelSyncHint" : "gateway.modelSyncHint") : "gateway.saveHint")}</p>
            {error && <div className="provider-error" role="alert">{error}</div>}
            <div className="ms-form-actions gateway-form-actions">
              <div className="gateway-management-actions">
                <button type="button" disabled={busy} onClick={manageAgents}>{t("gateway.manageAgents")}</button>
                <button type="button" disabled={busy} onClick={manageModels}>{t("gateway.manageModels")}</button>
              </div>
              <div className="gateway-submit-actions">
                <button className="ms-btn" type="button" disabled={busy} onClick={() => setDraft(null)}>{t("models.form.cancel")}</button>
                <button className="ms-btn primary" type="submit" disabled={busy || !validDraft}>{busy ? <SpinnerIcon /> : t("gateway.saveRoute")}</button>
              </div>
            </div>
          </form>}
          {connection && <><p className="ms-form-sub">{t("gateway.connectionHint")}</p>{(["baseUrl", "apiKey"] as const).map((key) => <label className="ms-field" key={key}><span>{key === "baseUrl" ? "Base URL" : "API key"}</span><div className="gateway-credential"><input {...textInputProps} readOnly type={key === "apiKey" ? "password" : "text"} value={connection[key]} /><button className="ms-btn" title={t("gateway.copy")} aria-label={`${t("gateway.copy")}: ${key}`} onClick={() => void copy(connection[key], key)}>{copied === key ? <Check size={15} /> : <Copy size={15} />}</button></div></label>)}{error && <div className="provider-error" role="alert">{error}</div>}<div className="ms-form-actions"><button className="ms-btn" onClick={() => setConnection(null)}>{t("gateway.done")}</button></div></>}
          {confirm && <><p className="ms-form-sub">{t(confirm.action === "connect" ? (confirm.route.agent === "hermes" ? "gateway.hermesConnectHint" : "gateway.connectHint") : confirm.route.connected ? "gateway.restoreHint" : "gateway.deleteHint", { name: confirm.route.name })}</p>{error && <div className="provider-error" role="alert">{error}</div>}<div className="ms-form-actions"><button className="ms-btn" disabled={busy} onClick={() => setConfirm(null)}>{t("models.form.cancel")}</button><button className="ms-btn primary" disabled={busy} onClick={() => void run(async () => { setState(await routeAction(confirm.action, confirm.route.id)); setConfirm(null); })}>{busy ? <SpinnerIcon /> : t(`gateway.${confirm.action}Title`)}</button></div></>}
        </div>
      </div>}
    </div>
  );
}
