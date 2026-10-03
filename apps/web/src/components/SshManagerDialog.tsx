import { textInputProps } from "../textInputProps";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiPath } from "../api";
import { useI18n } from "../i18n";
import { registerOccluder, unregisterOccluder } from "../nativeViewOcclusion";
import { EditIcon, PlusIcon, SshIcon, SpinnerIcon, TrashIcon } from "./icons";

export interface SshProfile {
  id: string;
  name: string;
  host: string;
  user?: string;
  port?: number;
  authMethod?: "default" | "password" | "identity";
  identityFile?: string;
  remoteDir?: string;
}

type AuthMethod = NonNullable<SshProfile["authMethod"]>;
type TestStatus = "connected" | "passwordRequired" | "hostKey" | "timeout" | "failed";
const blank = (): SshProfile => ({ id: crypto.randomUUID(), name: "", host: "", authMethod: "default" });
const profileAuthMethod = (profile: SshProfile): AuthMethod =>
  profile.authMethod ?? (profile.identityFile ? "identity" : "default");

export function SshManagerDialog({
  onClose,
  onSaved,
  editProfileId,
}: {
  onClose: () => void;
  onSaved: (profiles: SshProfile[]) => void;
  editProfileId?: string;
}) {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<SshProfile[]>([]);
  const [form, setForm] = useState<SshProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openedInitialEdit = useRef(false);
  const occluderId = useId();

  const reload = async () => {
    const profileRes = await fetch(apiPath("/api/ssh/profiles"));
    if (!profileRes.ok) throw new Error(String(profileRes.status));
    const profilePayload = await profileRes.json();
    const nextProfiles = Array.isArray(profilePayload.profiles) ? profilePayload.profiles : [];
    setProfiles(nextProfiles);
    if (editProfileId && !openedInitialEdit.current) {
      setForm(nextProfiles.find((profile: SshProfile) => profile.id === editProfileId) ?? null);
      openedInitialEdit.current = true;
    }
  };

  useEffect(() => {
    reload().catch((reason) => setError(String(reason))).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    const sync = () => registerOccluder(occluderId, backdrop.getBoundingClientRect());
    const observer = new ResizeObserver(sync);
    observer.observe(backdrop);
    sync();
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      observer.disconnect();
      unregisterOccluder(occluderId);
    };
  }, [occluderId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") form ? setForm(null) : onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [form, onClose]);

  useEffect(() => {
    setTestStatus(null);
  }, [form?.host, form?.user, form?.port, form?.authMethod, form?.identityFile]);

  const persist = async (next: SshProfile[]) => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(apiPath("/api/ssh/profiles"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profiles: next }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || String(res.status));
      setProfiles(payload.profiles);
      setForm(null);
      await reload();
      onSaved(payload.profiles);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const normalizedForm = (): SshProfile | null => {
    if (!form?.name.trim() || !form.host.trim()) return null;
    const at = form.host.lastIndexOf("@");
    const withHost = at > 0
      ? { ...form, user: form.host.slice(0, at), host: form.host.slice(at + 1) }
      : form;
    const authMethod = profileAuthMethod(withHost);
    if (authMethod === "identity" && !withHost.identityFile?.trim()) return null;
    return {
      ...withHost,
      authMethod,
      identityFile: authMethod === "identity" ? withHost.identityFile : undefined,
      remoteDir: withHost.remoteDir?.trim() || undefined,
    };
  };

  const saveForm = () => {
    const normalized = normalizedForm();
    if (!normalized) return;
    void persist([...profiles.filter((item) => item.id !== normalized.id), normalized]);
  };

  const testConnection = async () => {
    const profile = normalizedForm();
    if (!profile || testing) return;
    setTesting(true);
    setTestStatus(null);
    try {
      const response = await fetch(apiPath("/api/ssh/test"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      const payload = await response.json();
      setTestStatus(response.ok ? payload.status : "failed");
    } catch {
      setTestStatus("failed");
    } finally {
      setTesting(false);
    }
  };

  const editing = form ? profiles.some((profile) => profile.id === form.id) : false;
  const authMethod = form ? profileAuthMethod(form) : "default";
  const setAuthMethod = (next: AuthMethod) => {
    if (!form) return;
    setForm({
      ...form,
      authMethod: next,
      identityFile: next === "identity" ? form.identityFile ?? "" : undefined,
    });
  };

  return createPortal(
    <div
      ref={backdropRef}
      className="ws-dialog-backdrop ssh-manager-backdrop"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <div ref={dialogRef} className="ssh-manager-dialog" role="dialog" aria-modal="true" tabIndex={-1}>
        <header className="ssh-manager-header">
          <h2>{form ? t(editing ? "ssh.managerEdit" : "ssh.managerAdd") : t("ssh.managerTitle")}</h2>
          <div className="ssh-manager-header-actions">
            <button className="ssh-manager-close" onClick={form ? () => setForm(null) : onClose} aria-label={t("common.close")}>×</button>
          </div>
        </header>
        {!form && <div className="ssh-manager-toolbar"><button className="ssh-manager-add" onClick={() => setForm(blank())}><PlusIcon />{t("ssh.add")}</button></div>}
        {form ? (
          <div className="ssh-profile-form">
            <label>{t("ssh.profileName")}<input {...textInputProps} autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label>{t("ssh.profileHost")}<input {...textInputProps} placeholder={t("ssh.hostPlaceholder")} value={`${form.user ? `${form.user}@` : ""}${form.host}`} onChange={(e) => setForm({ ...form, user: undefined, host: e.target.value })} /></label>
            <label>{t("ssh.profilePort")}<input {...textInputProps} inputMode="numeric" value={form.port ?? ""} onChange={(e) => setForm({ ...form, port: e.target.value ? Number(e.target.value) : undefined })} /></label>
            <fieldset className="ssh-auth-field">
              <legend>{t("ssh.authentication")}</legend>
              <div className="ssh-auth-switch">
                {(["default", "password", "identity"] as const).map((method) => (
                  <button key={method} type="button" className={authMethod === method ? "active" : ""} aria-pressed={authMethod === method} onClick={() => setAuthMethod(method)}>
                    {t(`ssh.auth.${method}`)}
                  </button>
                ))}
              </div>
              <p>{t(authMethod === "password" ? "ssh.passwordHint" : authMethod === "identity" ? "ssh.identityHint" : "ssh.defaultAuthHint")}</p>
            </fieldset>
            {authMethod === "identity" && <label>{t("ssh.identityFile")}<input {...textInputProps} placeholder="~/.ssh/id_ed25519" value={form.identityFile ?? ""} onChange={(e) => setForm({ ...form, identityFile: e.target.value })} /></label>}
            <label>{t("ssh.remoteDir")}<input {...textInputProps} placeholder={t("ssh.remoteDirPlaceholder")} value={form.remoteDir ?? ""} onChange={(e) => setForm({ ...form, remoteDir: e.target.value })} /></label>
            {error && <div className="ssh-manager-error">{error}</div>}
            <div className="ssh-manager-actions">
              <div className={`ssh-test-status ${testStatus ?? ""}`}>{testStatus ? t(`ssh.test.${testStatus}`) : ""}</div>
              <div className="ssh-manager-action-buttons">
                <button className="test" disabled={testing || !normalizedForm()} onClick={() => void testConnection()}>{testing ? t("ssh.testing") : t("ssh.testConnection")}</button>
                <button onClick={() => setForm(null)}>{t("common.cancel")}</button>
                <button className="primary" disabled={saving || !normalizedForm()} onClick={saveForm}>{saving ? t("ssh.configSaving") : t("common.done")}</button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="ssh-manager-list">
              {loading && <div className="ssh-manager-empty"><SpinnerIcon /> {t("ssh.loading")}</div>}
              {profiles.map((profile) => <div className="ssh-manager-row" key={profile.id}><SshIcon /><div><strong>{profile.name}</strong><span>{profile.user ? `${profile.user}@` : ""}{profile.host}{profile.port ? `:${profile.port}` : ""}</span></div><button title={t("ssh.editConnection")} aria-label={t("ssh.editConnection")} onClick={() => setForm(profile)}><EditIcon /></button><button title={t("ssh.deleteConnection")} aria-label={t("ssh.deleteConnection")} onClick={() => void persist(profiles.filter((item) => item.id !== profile.id))}><TrashIcon /></button></div>)}
              {!loading && profiles.length === 0 && <div className="ssh-manager-empty">{t("ssh.managerEmpty")}</div>}
            </div>
            {error && <div className="ssh-manager-error">{error}</div>}
          </>
        )}
      </div>
    </div>, document.body
  );
}
