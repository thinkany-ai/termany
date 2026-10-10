import { useEffect, useState } from "react";
import type { BotContextPreview, SkillCatalogResponse, SkillReadResult } from "@termany/core";
import { behaviorDraft, behaviorFingerprint, behaviorIdentity, jsonRequest, moveBinding, skillApi, type BotBehaviorDraft } from "../botBehaviorForm";
import { useI18n } from "../i18n";
import { useStore, type AgentConversation } from "../state/store";
import { SkillPicker } from "./SkillPicker";
import "./BotBehaviorForm.css";

export async function validateBehavior(name: string, value: BotBehaviorDraft): Promise<BotContextPreview> {
  return skillApi("/api/bot-context/preview", jsonRequest({ botIdentity: behaviorIdentity(name, value) }));
}

export function BotBehaviorForm({ value, onChange, disabled = false }: {
  value: BotBehaviorDraft; onChange: (draft: BotBehaviorDraft) => void; name: string; disabled?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [unavailable, setUnavailable] = useState<Record<string, boolean>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    void skillApi<SkillCatalogResponse>("/api/skill-catalog").then(c => {
      if (live) setNames(n => ({ ...n, ...Object.fromEntries(c.skills.flatMap(s => [[s.id, s.name], ...(s.aliases ?? []).map(a => [a.id, s.name])])) }));
    }).catch(() => {});
    // Legacy bindings retain their exact snapshot until server-side migration.
    for (const b of value.agentSkills) {
      const path = b.revision ? `/api/skills/${encodeURIComponent(b.skillId)}/revisions/${encodeURIComponent(b.revision)}` : `/api/skill-catalog/${encodeURIComponent(b.skillId)}`;
      void skillApi<SkillReadResult>(path).then(s => { if (live) { setNames(n => ({ ...n, [b.skillId]: s.name })); setUnavailable(n => ({ ...n, [b.skillId]: false })); } }).catch(() => { if (live) setUnavailable(n => ({ ...n, [b.skillId]: true })); });
    }
    return () => { live = false; };
  }, [JSON.stringify(value.agentSkills)]);
  return <fieldset className="bot-behavior" disabled={disabled}>
    <label>{t("botBehavior.description")}<textarea rows={3} placeholder={t("botBehavior.descriptionPlaceholder")} value={value.agentDescription} onChange={e => onChange({ ...value, agentDescription: e.target.value })} /></label>
    <section className="bot-skill-section">
      <div className="bot-behavior-heading"><div><strong>{t("botBehavior.skills")}</strong><small>{t("botBehavior.skillSummary")}</small></div><button type="button" onClick={() => setOpen(true)}>{t("botBehavior.chooseSkills")}</button></div>
      {!value.agentSkills.length && <div className="bot-skill-empty"><span aria-hidden="true">＋</span><div><strong>{t("botBehavior.unbound")}</strong><small>{t("botBehavior.unboundHint")}</small></div></div>}
      {value.agentSkills.map((binding, index) => <div className="bot-bound-skill" key={`${binding.skillId}:${binding.revision ?? ""}`}>
        <span className="bot-skill-number">{index + 1}</span><strong>{names[binding.skillId] ?? binding.skillId}{unavailable[binding.skillId] && <small className="skill-unavailable">{t("botBehavior.missing")}</small>}</strong>
        <details className="bot-skill-order"><summary aria-label={t("botBehavior.reorder")}>⋯</summary><div><button type="button" disabled={index === 0} onClick={() => onChange({ ...value, agentSkills: moveBinding(value.agentSkills, index, -1) })}>{t("botBehavior.up")}</button><button type="button" disabled={index === value.agentSkills.length - 1} onClick={() => onChange({ ...value, agentSkills: moveBinding(value.agentSkills, index, 1) })}>{t("botBehavior.down")}</button></div></details>
        <button type="button" aria-label={`${t("botBehavior.remove")} ${names[binding.skillId] ?? binding.skillId}`} onClick={() => onChange({ ...value, agentSkills: value.agentSkills.filter((_, i) => i !== index) })}>×</button>
      </div>)}
    </section>
    {open && <SkillPicker bindings={value.agentSkills} onClose={() => setOpen(false)} onConfirm={bindings => { onChange({ ...value, agentSkills: bindings }); setOpen(false); }} />}
  </fieldset>;
}

export function BotBehaviorEditor({ conversation }: { conversation: AgentConversation }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(() => behaviorDraft(conversation));
  const [baseline, setBaseline] = useState(() => behaviorFingerprint(conversation));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const conflict = behaviorFingerprint(conversation) !== baseline;
  const reload = () => { setDraft(behaviorDraft(conversation)); setBaseline(behaviorFingerprint(conversation)); setError(""); setSaved(false); };
  const save = async (overwrite = false) => {
    if (saving) return;
    const current = useStore.getState().agentConversations.find(c => c.id === conversation.id);
    if (!current) { setError(t("botBehavior.deleted")); return; }
    const expected = behaviorFingerprint(current);
    if (!overwrite && expected !== baseline) { setError(t("botBehavior.conflict")); return; }
    setSaving(true); setError(""); setSaved(false);
    try {
      await validateBehavior(current.title, draft);
      const latest = useStore.getState().agentConversations.find(c => c.id === conversation.id);
      if (!latest) throw new Error(t("botBehavior.deleted"));
      if (behaviorFingerprint(latest) !== expected) throw new Error(t("botBehavior.conflict"));
      useStore.getState().setAgentConversationMeta(conversation.id, draft);
      setBaseline(behaviorFingerprint(draft)); setSaved(true);
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  };
  return <div className="bot-behavior-editor"><BotBehaviorForm value={draft} onChange={d => { setDraft(d); setSaved(false); }} name={conversation.title} disabled={saving} />
    {conflict && <div role="alert"><p>{t("botBehavior.conflict")}</p><button type="button" disabled={saving} onClick={reload}>{t("botBehavior.reload")}</button><button type="button" disabled={saving} onClick={() => void save(true)}>{t("botBehavior.overwrite")}</button></div>}
    {error && <p role="alert" className="bot-behavior-error">{error}</p>}
    <div className="bot-behavior-actions">
      {saved && <small className="bot-behavior-saved" role="status">{t("botBehavior.saved")}</small>}
      <button type="button" className="bot-behavior-save" disabled={saving || conflict} onClick={() => void save()}>{t(saving ? "botBehavior.saving" : "botBehavior.save")}</button>
    </div>
  </div>;
}
