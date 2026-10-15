import { textInputProps } from "../textInputProps";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { apiPath } from "../api";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { HEADER_POPOVER_STYLE, usePaneHeadPopover } from "./usePaneHeadPopover";
import { useStore } from "../state/store";
import { subscribeTerminalConnectionStatus, terminalConnectionStatus } from "../terminal/manager";
import { CheckIcon, ChevronIcon, EditIcon, GearIcon, SshIcon, SpinnerIcon, TerminalIcon } from "./icons";
import { SshManagerDialog } from "./SshManagerDialog";

interface SshConnection {
  target: string;
  source: string;
  label?: string;
  hostname?: string;
  profileId?: string;
}

/** Connection launcher modeled after Wave's per-block connection picker. */
export function SshConnections({
  paneId,
  currentTarget,
  currentLabel,
  localLabel,
}: {
  paneId: string;
  currentTarget?: string;
  currentLabel?: string;
  localLabel?: string;
}) {
  const { t } = useI18n();
  const ime = useImeGuard();
  const setPaneSshTarget = useStore((s) => s.setPaneSshTarget);
  const renamePane = useStore((s) => s.renamePane);
  const [open, setOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [editProfileId, setEditProfileId] = useState<string>();
  const [editingLocal, setEditingLocal] = useState(false);
  const [localName, setLocalName] = useState("");
  const [target, setTarget] = useState("");
  const [savingTarget, setSavingTarget] = useState(false);
  const [targetError, setTargetError] = useState(false);
  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [, setConnectionStatusVersion] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const { rootRef, panelRef } = usePaneHeadPopover(open, close, "left");

  useEffect(() => subscribeTerminalConnectionStatus(() => {
    setConnectionStatusVersion((version) => version + 1);
  }), []);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(false);
    const abort = new AbortController();
    fetch(apiPath("/api/ssh/connections"), { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const payload = await res.json();
        setConnections(Array.isArray(payload.connections) ? payload.connections : []);
      })
      .catch((reason) => {
        if (reason?.name !== "AbortError") setError(true);
      })
      .finally(() => setLoading(false));
    return () => {
      abort.abort();
    };
  }, [open]);

  const connect = (value?: string, label?: string) => {
    if (!value) {
      if (currentTarget) setPaneSshTarget(paneId);
      setTarget("");
      setOpen(false);
      return;
    }
    const destination = value.trim();
    if (!destination) return;
    if (destination !== currentTarget) setPaneSshTarget(paneId, destination, label);
    setTarget("");
    setOpen(false);
  };

  const finishLocalRename = () => {
    const name = localName.trim();
    if (name) renamePane(paneId, name);
    setEditingLocal(false);
  };

  const connectManual = async () => {
    const destination = target.trim();
    if (!destination || savingTarget) return;
    setSavingTarget(true);
    setTargetError(false);
    try {
      const response = await fetch(apiPath("/api/ssh/profiles/from-target"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: destination }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.profile?.id) throw new Error(payload?.error || String(response.status));
      const profile = payload.profile;
      const connection: SshConnection = {
        target: `profile:${profile.id}`,
        profileId: profile.id,
        label: profile.name,
        hostname: `${profile.user ? `${profile.user}@` : ""}${profile.host}`,
        source: "termany",
      };
      setConnections((items) => items.some((item) => item.target === connection.target) ? items : [...items, connection]);
      connect(connection.target, connection.label);
    } catch {
      setTargetError(true);
    } finally {
      setSavingTarget(false);
    }
  };

  return (
    <>
    <div className="pane-connection" ref={rootRef}>
      <button
        type="button"
        className={`pane-connection-trigger ${open ? "active" : ""}`}
        title={t("ssh.open")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {currentTarget ? <SshIcon /> : <TerminalIcon />}
        <span>{currentTarget ? currentLabel ?? currentTarget : localLabel ?? t("pane.view.terminal")}</span>
        <ChevronIcon dir="down" />
      </button>
      {open && createPortal(
        <div
          className="agent-menu ssh-menu pane-connection-menu"
          ref={panelRef}
          role="dialog"
          aria-label={t("ssh.open")}
          style={HEADER_POPOVER_STYLE}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <form
            autoComplete="off"
            className="ssh-connect-form"
            onSubmit={(event) => {
              event.preventDefault();
              void connectManual();
            }}
          >
            <SshIcon />
            <input
              {...textInputProps}
              autoFocus
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={t("ssh.placeholder")}
              aria-label={t("ssh.destination")}
              disabled={savingTarget}
            />
          </form>
          {targetError && <div className="ssh-connect-error">{t("ssh.saveFailed")}</div>}
          <div className="ws-menu-item ssh-connection-row">
            <button type="button" className="ws-menu-pick ssh-connection-pick" onClick={() => connect()}>
              <TerminalIcon />
              {editingLocal ? (
                <input
                  {...textInputProps}
                  className="ssh-local-name-input"
                  autoFocus
                  value={localName}
                  aria-label={t("ssh.localName")}
                  onClick={(event) => event.stopPropagation()}
                  {...ime.props}
                  onChange={(event) => setLocalName(event.target.value)}
                  onBlur={finishLocalRename}
                  onKeyDown={(event) => {
                    if (ime.handled(event)) return;
                    if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                    else if (event.key === "Escape") setEditingLocal(false);
                  }}
                />
              ) : <span className="ws-menu-name">{localLabel ?? t("ssh.local")}</span>}
            </button>
            <button
              type="button"
              className="ws-menu-edit ssh-connection-edit"
              title={t("ssh.renameLocal")}
              aria-label={t("ssh.renameLocal")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setLocalName(localLabel ?? t("ssh.local"));
                setEditingLocal(true);
              }}
            ><EditIcon /></button>
            {!currentTarget && <span className="ws-check"><CheckIcon /></span>}
          </div>
          <div className="ssh-menu-label">{t("ssh.configHosts")}</div>
          <div className="ssh-host-list">
            {loading && <div className="ssh-menu-empty"><SpinnerIcon /> {t("ssh.loading")}</div>}
            {!loading && error && <div className="ssh-menu-empty">{t("ssh.loadFailed")}</div>}
            {!loading && !error && connections.length === 0 && (
              <div className="ssh-menu-empty">{t("ssh.noHosts")}</div>
            )}
            {!loading &&
              connections.map((connection) => {
                const connected = terminalConnectionStatus(paneId, connection.target) === "connected";
                return <div className="ws-menu-item ssh-connection-row" key={connection.target}>
                  <button type="button" className="ws-menu-pick ssh-connection-pick" onClick={() => connect(connection.target, connection.label ?? connection.target)}>
                    <SshIcon />
                    <span className="ssh-connection-title">
                      <span>{connection.label ?? connection.target}</span>
                      {connected && <i className="ssh-connected-dot" title={t("ssh.status.connected")} />}
                    </span>
                  </button>
                  {connection.profileId && <button
                    type="button"
                    className="ws-menu-edit ssh-connection-edit"
                    title={t("ssh.editConnection")}
                    aria-label={t("ssh.editConnection")}
                    onClick={() => {
                      setOpen(false);
                      setEditProfileId(connection.profileId);
                      setConfigOpen(true);
                    }}
                  ><EditIcon /></button>}
                  {connection.target === currentTarget && <span className="ws-check"><CheckIcon /></span>}
                </div>;
              })}
          </div>
          <div className="ws-menu-sep ssh-menu-separator" />
          <button
            type="button"
            className="ws-menu-row ssh-config-edit"
            onClick={() => {
              setOpen(false);
              setEditProfileId(undefined);
              setConfigOpen(true);
            }}
          >
            <GearIcon />
            <span className="ws-menu-name">{t("ssh.configEdit")}</span>
          </button>
        </div>,
        document.body
      )}
    </div>
    {configOpen && (
      <SshManagerDialog
        editProfileId={editProfileId}
        onClose={() => {
          setConfigOpen(false);
          setEditProfileId(undefined);
        }}
        onSaved={(profiles) => {
          if (!currentTarget?.startsWith("profile:")) return;
          const current = profiles.find((profile) => `profile:${profile.id}` === currentTarget);
          if (current) setPaneSshTarget(paneId, currentTarget, current.name);
        }}
      />
    )}
    </>
  );
}
