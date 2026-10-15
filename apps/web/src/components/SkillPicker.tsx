import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BOT_SKILL_LIMITS, type BotSkillBinding, type SkillCatalogEntry, type SkillCatalogResponse, type SkillImportJob, type SkillReadResult } from "@termany/core";
import { addCatalogBinding, jsonRequest, skillApi } from "../botBehaviorForm";
import { Markdown } from "./Markdown";
import { rememberImportedSkill, skillPreviewBody, type ImportedSkill } from "../skillPickerState";
import { useI18n } from "../i18n";

export function SkillPicker({ bindings, onClose, onConfirm }: { bindings: BotSkillBinding[]; onClose: () => void; onConfirm: (bindings: BotSkillBinding[]) => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(() => bindings.map(b => ({ ...b })));
  const [canonicalIds, setCanonicalIds] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState(bindings.some(b => !!b.revision));
  const bindingKey = (b: BotSkillBinding) => `${b.skillId}:${b.revision ?? ""}`;
  const selectedId = (b: BotSkillBinding) => canonicalIds[bindingKey(b)] ?? b.skillId;
  const [catalog, setCatalog] = useState<SkillCatalogResponse>();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [source, setSource] = useState("");
  const [tab, setTab] = useState<"library" | "github">("library");
  const [imports, setImports] = useState<ImportedSkill[]>([]);
  const [detailEntry, setDetailEntry] = useState<SkillCatalogEntry>();
  const [detailError, setDetailError] = useState("");
  const [filesError, setFilesError] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<{ element: HTMLElement; skillId: string; scroll: number }>();
  const scrollByTab = useRef({ library: 0, github: 0 });
  const catalogBeforeImport = useRef<SkillCatalogEntry[]>([]);
  const [selectingImport, setSelectingImport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<SkillImportJob>();
  const [detail, setDetail] = useState<SkillReadResult>();
  const [files, setFiles] = useState<Array<{ path: string; bytes: number }>>([]);
  const [detailBusy, setDetailBusy] = useState(false);
  const detailGeneration = useRef(0);
  const mounted = useRef(true);
  const activeJob = useRef<SkillImportJob>();
  activeJob.current = job;
  const cancelPending = async () => {
    const pending = activeJob.current;
    if (pending && ["running", "select-entry"].includes(pending.status)) {
      await skillApi(`/api/skills/imports/${encodeURIComponent(pending.id)}`, { method: "DELETE" });
      activeJob.current = undefined;
    }
  };
  const refresh = async (scan = false) => {
    setLoading(true); setError("");
    try {
      const result = await skillApi<SkillCatalogResponse>(scan ? "/api/skill-catalog/refresh" : "/api/skill-catalog", scan ? { method: "POST" } : undefined);
      if (mounted.current) setCatalog(result);
      return result;
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    void Promise.all(bindings.filter(b => b.revision).map(async b => {
      try { const detail = await skillApi<SkillReadResult>(`/api/skill-catalog/${encodeURIComponent(b.skillId)}?revision=${encodeURIComponent(b.revision!)}`); return [bindingKey(b), detail.id] as const; }
      catch { return [bindingKey(b), b.skillId] as const; }
    })).then(entries => { if (mounted.current) { setCanonicalIds(Object.fromEntries(entries)); setResolving(false); } });
    void refresh().then(() => { if (mounted.current) void refresh(true); });
    return () => { mounted.current = false; void cancelPending().catch(() => {}); previous?.focus(); };
  }, []);
  const receiveJob = (next: SkillImportJob) => {
    activeJob.current = next;
    setJob(next);
    if (next.status === "complete" && next.binding) {
      const binding = next.binding;
      setSelectingImport(true);
      void refresh().then(result => {
        if (!mounted.current) return;
        const skills = result?.skills ?? catalog?.skills ?? [];
        setImports(old => rememberImportedSkill(old, binding.skillId, skills, catalogBeforeImport.current));
        setSelected(old => addCatalogBinding(old, binding.skillId, skills, canonicalIds));
      }).finally(() => { if (mounted.current) setSelectingImport(false); });
    }
  };
  useEffect(() => {
    if (job?.status !== "running") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await skillApi<SkillImportJob>(`/api/skills/imports/${encodeURIComponent(job.id)}`);
        if (!live) return;
        receiveJob(next);
        if (next.status === "running") timer = setTimeout(poll, 800);
      } catch (e) { if (live) { setError(String(e)); timer = setTimeout(poll, 2000); } }
    };
    timer = setTimeout(poll, 800);
    return () => { live = false; clearTimeout(timer); };
  }, [job?.id, job?.status]);
  const runImport = async (entry?: string) => {
    if (busy || resolving) return;
    setBusy(true); setError("");
    try {
      if (entry === undefined) { await cancelPending(); catalogBeforeImport.current = catalog?.skills ?? []; }
      const next = await skillApi<SkillImportJob>(entry !== undefined && job ? `/api/skills/imports/${encodeURIComponent(job.id)}/select` : "/api/skills/import", jsonRequest(entry !== undefined ? { entry } : { source: { kind: "github", url: source.trim() } }));
      if (mounted.current) receiveJob(next);
      else if (["running", "select-entry"].includes(next.status)) void skillApi(`/api/skills/imports/${encodeURIComponent(next.id)}`, { method: "DELETE" }).catch(() => {});
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const visible = (catalog?.skills ?? []).filter(s => `${s.name} ${s.description} ${s.root}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  const importRunning = busy || selectingImport || job?.status === "running";
  const idsFor = (s: SkillCatalogEntry) => [s.id, ...(s.aliases ?? []).map(a => a.id)];
  const isSelected = (s: SkillCatalogEntry) => selected.some(b => idsFor(s).includes(selectedId(b)));
  const toggle = (s: SkillCatalogEntry, checked: boolean) => setSelected(old => checked ? addCatalogBinding(old, s.id, catalog?.skills ?? [s], canonicalIds) : old.filter(b => !idsFor(s).includes(selectedId(b))));
  const openDetail = (s: SkillCatalogEntry, element: HTMLElement) => {
    returnTo.current = { element, skillId: s.id, scroll: body.current?.scrollTop ?? 0 };
    const generation = ++detailGeneration.current;
    setDetailEntry(s); setDetailBusy(true); setDetail(undefined); setFiles([]); setDetailError(""); setFilesError("");
    void skillApi<{ files: Array<{ path: string; bytes: number }> }>(`/api/skill-catalog/${encodeURIComponent(s.id)}/files?limit=1000`).then(r => { if (mounted.current && generation === detailGeneration.current) setFiles(r.files); }).catch(e => { if (mounted.current && generation === detailGeneration.current) setFilesError(String(e)); });
    void skillApi<SkillReadResult>(`/api/skill-catalog/${encodeURIComponent(s.id)}`).then(d => { if (mounted.current && generation === detailGeneration.current) setDetail(d); }).catch(e => { if (mounted.current && generation === detailGeneration.current) setDetailError(String(e)); }).finally(() => { if (mounted.current && generation === detailGeneration.current) setDetailBusy(false); });
  };
  const closeDetail = () => { ++detailGeneration.current; setDetailEntry(undefined); };
  useLayoutEffect(() => {
    if (detailEntry) { if (body.current) body.current.scrollTop = 0; backButton.current?.focus({ preventScroll: true }); }
    else if (returnTo.current) {
      if (body.current) body.current.scrollTop = returnTo.current.scroll;
      const original = returnTo.current.element;
      const savedId = returnTo.current.skillId;
      const restored = original.isConnected && original.dataset.skillDetail === savedId ? original : Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>("[data-skill-detail]") ?? []).find(el => el.dataset.skillDetail === savedId);
      restored?.focus({ preventScroll: true }); returnTo.current = undefined;
    } else if (body.current) body.current.scrollTop = scrollByTab.current[tab];
  }, [detailEntry, tab]);
  const switchTab = (next: typeof tab) => { scrollByTab.current[tab] = body.current?.scrollTop ?? 0; setTab(next); };
  const option = (s: SkillCatalogEntry, status?: string) => {
    const checked = isSelected(s);
    return <div className="skill-picker-option" key={s.id}>
      <label><input type="checkbox" checked={checked} disabled={resolving || (!checked && (!s.available || selected.length >= BOT_SKILL_LIMITS.bindings))} onChange={e => toggle(s, e.target.checked)} /><span><strong>{s.name}</strong>{status ? <small>{status} · {t(checked ? "botBehavior.pendingSelected" : "botBehavior.notSelected")}</small> : <small>{s.description}</small>}<span className="skill-source-tag" title={s.root}>{s.source === "github" ? "GitHub" : s.root}</span>{!s.available && <small className="skill-unavailable">{s.error || t("botBehavior.missing")}</small>}</span></label>
      <button type="button" data-skill-detail={s.id} onClick={e => openDetail(s, e.currentTarget)}>{t("botBehavior.viewDetails")}</button>
    </div>;
  };
  return createPortal(<dialog ref={dialog} className="skill-picker bot-behavior" aria-labelledby="skill-picker-title" onCancel={e => { e.preventDefault(); e.stopPropagation(); if (detailEntry) closeDetail(); else onClose(); }} onKeyDown={e => e.stopPropagation()}>
    <header className="bot-behavior-heading"><div><strong id="skill-picker-title">{t("botBehavior.chooseSkills")}</strong><small>{t("botBehavior.pickerHint")}</small></div><button type="button" aria-label={t("common.close")} onClick={onClose}>×</button></header>
    <div key={detailEntry ? `detail:${detailEntry.id}` : tab} className="skill-picker-view">
    {detailEntry ? <div className="skill-detail-toolbar"><button ref={backButton} type="button" onClick={closeDetail}>← {t("botBehavior.backToList")}</button><strong>{detailEntry.name}</strong><label><input type="checkbox" checked={isSelected(detailEntry)} disabled={resolving || (!isSelected(detailEntry) && (!detailEntry.available || selected.length >= BOT_SKILL_LIMITS.bindings))} onChange={e => toggle(detailEntry, e.target.checked)} />{t(isSelected(detailEntry) ? "botBehavior.pendingSelected" : "botBehavior.notSelected")}</label></div> : <>
      <nav className="skill-picker-tabs" aria-label={t("botBehavior.chooseSkills")}><button type="button" aria-pressed={tab === "library"} onClick={() => switchTab("library")}>{t("botBehavior.existingSkills")}</button><button type="button" aria-pressed={tab === "github"} onClick={() => switchTab("github")}>{t("botBehavior.githubImport")}{!!imports.length && <span>{imports.length}</span>}</button></nav>
      {tab === "library" && <div className="bot-behavior-row"><input autoFocus aria-label={t("botBehavior.search")} placeholder={t("botBehavior.search")} value={query} onChange={e => setQuery(e.target.value)} /><button type="button" disabled={loading} onClick={() => void refresh(true)}>{t("botBehavior.refresh")}</button></div>}
    </>}
    <div ref={body} className="skill-picker-body">
      {detailEntry ? <section className="skill-detail-view">
        <p>{detailEntry.description}</p><small>{detailEntry.entryPath}</small>
        {detailBusy && <small role="status">{t("botBehavior.loading")}</small>}
        {detailError && <p role="alert" className="bot-behavior-error">{detailError.replace(/^Error: /, "")}</p>}
        {detail && <Markdown text={skillPreviewBody(detail.body)} />}
        <details><summary>{t("botBehavior.details")}</summary>{filesError ? <small className="skill-unavailable">{filesError}</small> : files.map(f => <small key={f.path}>{f.path} · {f.bytes} B</small>)}</details>
      </section> : tab === "library" ? <>
        {loading && <small role="status">{t("botBehavior.loading")}</small>}
        <div className="skill-picker-results">{visible.map(s => option(s))}{!loading && !visible.length && <div className="bot-skill-empty"><small>{t("botBehavior.empty")}</small></div>}</div>
        {!!catalog?.warnings.length && <details><summary>{t("botBehavior.sourceWarnings")}</summary>{catalog.warnings.map((w, i) => <small key={i}>{w}</small>)}</details>}
      </> : <>
        <section className="skill-import-form"><label>{t("botBehavior.github")}<input placeholder="https://github.com/owner/repository/tree/main/skill" value={source} onChange={e => setSource(e.target.value)} disabled={importRunning} /></label><small>{t("botBehavior.githubLinkHint")}</small>
          <div className="bot-behavior-row"><button type="button" className="skill-primary" disabled={!source.trim() || importRunning || resolving} onClick={() => void runImport()}>{t(importRunning ? "botBehavior.running" : "botBehavior.import")}</button>{(job?.status === "running" || job?.status === "select-entry") && <button type="button" onClick={() => void skillApi<SkillImportJob>(`/api/skills/imports/${encodeURIComponent(job.id)}`, { method: "DELETE" }).then(j => { if (mounted.current) receiveJob(j); }).catch(e => { if (mounted.current) setError(String(e)); })}>{t("botBehavior.cancel")}</button>}</div>
          {job?.status === "select-entry" && <div className="skill-entry-options"><small>{t("botBehavior.chooseEntry")}</small>{job.candidates?.map(entry => <button type="button" key={entry} disabled={busy} onClick={() => void runImport(entry)}>{entry || "."}</button>)}</div>}
          {job?.status === "failed" && <p role="alert" className="bot-behavior-error">{job.error} {job.code}{job.retryAt && <small>{t("botBehavior.retryAt", { time: new Date(job.retryAt).toLocaleString() })}</small>}</p>}
          {job?.status === "complete" && <small role="status">{t("botBehavior.downloadComplete")}</small>}
        </section>
        <section className="skill-import-results"><strong>{t("botBehavior.thisImport")}</strong><small>{t("botBehavior.importSelectionHint")}</small>{imports.length ? imports.map(item => option(catalog?.skills.find(s => idsFor(s).includes(item.id)) ?? item.skill, t(item.existed ? "botBehavior.alreadyInLibrary" : "botBehavior.downloaded"))) : <div className="bot-skill-empty"><small>{t("botBehavior.noImports")}</small></div>}</section>
      </>}
      {!detailEntry && error && <p role="alert" className="bot-behavior-error">{error.replace(/^Error: /, "")}</p>}
      {selected.length >= BOT_SKILL_LIMITS.bindings && <small role="status">{t("botBehavior.limit")}</small>}
    </div>
    </div>
    <footer className="skill-picker-footer"><button type="button" onClick={() => { onClose(); window.dispatchEvent(new CustomEvent("termany:open-settings", { detail: "skills" })); }}>{t("botBehavior.manageSources")}</button><span /><button type="button" onClick={onClose}>{t("common.cancel")}</button><button type="button" className="skill-primary" disabled={importRunning || resolving} onClick={() => onConfirm(selected)}>{t("botBehavior.confirmSelection", { count: selected.length })}</button></footer>
  </dialog>, document.body);
}
