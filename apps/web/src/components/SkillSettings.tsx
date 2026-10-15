import { useEffect, useRef, useState } from "react";
import type { SkillCatalogResponse, SkillSearchRoot } from "@termany/core";
import { jsonRequest, skillApi } from "../botBehaviorForm";
import { useI18n } from "../i18n";
import "./BotBehaviorForm.css";

export function SkillSettings() {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<SkillCatalogResponse>();
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const refresh = async () => {
    setBusy(true); setError("");
    try { const c = await skillApi<SkillCatalogResponse>("/api/skill-catalog/refresh", { method: "POST" }); if (mounted.current) setCatalog(c); }
    catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setBusy(false); }
  };
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, []);
  const save = async (roots: SkillSearchRoot[]) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await skillApi<SkillCatalogResponse>("/api/skill-roots", { ...jsonRequest({ roots }), method: "PUT" });
      if (mounted.current) { setCatalog(result); setPath(""); }
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const managed = (catalog?.skills ?? []).flatMap(s => [s, ...(s.aliases ?? []).filter(a => a.source).map(a => ({ ...s, ...a }))]).filter(s => s.source !== "local");
  return <section className="bot-behavior skill-settings">
    <div className="bot-behavior-heading"><div><h2>{t("settings.skills")}</h2><small>{t("botBehavior.rootsHint")}</small></div><button type="button" disabled={busy} onClick={() => void refresh()}>{t("botBehavior.refresh")}</button></div>
    {busy && <small role="status">{t("botBehavior.loading")}</small>}
    {catalog?.roots.map(root => <div className="skill-root" key={root.id}><label><input type="checkbox" checked={root.enabled} disabled={busy} onChange={e => void save(catalog.roots.map(r => r.id === root.id ? { ...r, enabled: e.target.checked } : r))} /><span><strong>{root.path}</strong><small>{root.builtIn ? t("botBehavior.defaultRoot") : t("botBehavior.customRoot")}{root.status ? ` · ${t(`botBehavior.root.${root.status}`)}` : ""}</small>{root.error && root.status !== "missing" && <small>{root.error}</small>}</span></label>{!root.builtIn && <button type="button" disabled={busy} onClick={() => void save(catalog.roots.filter(r => r.id !== root.id))}>{t("botBehavior.remove")}</button>}</div>)}
    <label>{t("botBehavior.addRoot")}<input value={path} disabled={busy} onChange={e => setPath(e.target.value)} placeholder="~/my-skills" /></label>
    <div className="bot-behavior-row"><button type="button" disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try { const r = await skillApi<{path?: string}>("/api/agent/acp/pick-cwd", jsonRequest({ prompt: t("botBehavior.addRoot"), defaultPath: path || undefined })); if (mounted.current && r.path) setPath(r.path); }
      catch (e) { if (mounted.current) setError(String(e)); }
      finally { if (mounted.current) setBusy(false); }
    }}>{t("botBehavior.browse")}</button><button type="button" disabled={busy || !path.trim() || !catalog} onClick={() => void save([...(catalog?.roots ?? []), { id: `custom-${crypto.randomUUID()}`, path: path.trim(), enabled: true, builtIn: false }])}>{t("botBehavior.addRoot")}</button></div>
    {!!catalog?.warnings.length && <details><summary>{t("botBehavior.sourceWarnings")}</summary>{catalog.warnings.map((w, i) => <small key={i}>{w}</small>)}</details>}
    {!!managed.length && <section><h3>{t("botBehavior.managed")}</h3><small>{t("botBehavior.managedHint")}</small>{managed.map(s => <div className="skill-root" key={s.id}><div style={{ flex: 1, minWidth: 0 }}><strong>{s.name}</strong><small>{s.root}</small></div><button type="button" disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try { await skillApi(`/api/skill-catalog/${encodeURIComponent(s.id)}`, { method: "DELETE" }); if (mounted.current) await refresh(); }
      catch (e) { if (mounted.current) setError(String(e)); }
      finally { if (mounted.current) setBusy(false); }
    }}>{t("botBehavior.remove")}</button></div>)}</section>}
    {error && <p className="bot-behavior-error" role="alert">{error.replace(/^Error: /, "")}</p>}
  </section>;
}
