import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { nexRequest, type PairingOffer } from "../state/devices";
import { textInputProps } from "../textInputProps";

/**
 * Connecting two devices (Settings → Devices):
 *
 *   device A                                  device B
 *   "Connect device" → paste B's               shows its authorization code
 *   authorization code → shows a
 *   connection code, waits ...........→       "Verify access" → type that code
 *   "Connected to B"                    ←.....  "Connected to A"
 *
 * The server does the work (apps/server/src/nexBridge.ts); B never displays
 * the connection code itself, so it has to come off A's screen.
 */

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The server explains failures in English for logs; the dialogs say the same
 * in the user's language and in plain words. Unknown ones pass through.
 */
const FRIENDLY: Array<[RegExp, string]> = [
  [/needs a newer Termany/i, "devices.err.newer"],
  [/authorization code is from a newer Termany/i, "devices.err.codeNewer"],
  [/not a Termany authorization code|authorization code is damaged/i, "devices.err.badCode"],
  [/own authorization code/i, "devices.err.ownCode"],
  [/code does not match/i, "devices.err.codeMismatch"],
  [/no device is asking to connect/i, "devices.err.noRequest"],
  [/too many pending requests/i, "devices.err.tooMany"],
  [/only accepts end-to-end encrypted connections/i, "devices.err.strict"],
  [/cannot be reached through your account/i, "devices.err.accountUnreachable"],
  [/^cannot reach /i, "devices.err.unreachable"],
  // The browser's own words for a request that never got an answer.
  [/^(load failed|failed to fetch|networkerror)/i, "devices.err.loadFailed"],
];

export function useFriendlyError(): (raw: string) => string {
  const { t } = useI18n();
  return (raw) => {
    const hit = FRIENDLY.find(([re]) => re.test(raw));
    return hit ? t(hit[1]) : raw;
  };
}

/** A failure in plain words; the server's own wording stays in the tooltip for troubleshooting. */
function ErrorLine({ error }: { error: string }) {
  const friendly = useFriendlyError()(error);
  return (
    <div className="ms-test-fail" title={friendly === error ? undefined : error}>
      {friendly}
    </div>
  );
}
const POLL_MS = 2_000;

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="ws-dialog-backdrop link-dialog-backdrop" onClick={onClose}>
      <div className="ws-dialog link-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="link-dialog-title">{title}</div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Step 1 + 3, on the device that connects. With `deviceId` (one of the
 * account's devices) the authorization code is fetched through the account,
 * so the dialog opens straight on the connection code.
 */
export function ConnectDialog({ deviceId, onClose }: { deviceId?: string; onClose: (connected: boolean) => void }) {
  const { t } = useI18n();
  const [authCode, setAuthCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [connected, setConnected] = useState(false);
  const started = useRef(false);

  const submit = useCallback(async (request: () => Promise<PairingOffer>) => {
    setBusy(true);
    setError(null);
    try {
      setOffer(await request());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!deviceId || started.current) return;
    started.current = true;
    void submit(() => nexRequest<PairingOffer>("peers/pair", { deviceId }));
  }, [deviceId, submit]);

  // Wait for the other device to verify the code.
  useEffect(() => {
    if (!offer || connected) return;
    let stopped = false;
    const poll = async () => {
      try {
        const { connected: done } = await nexRequest<{ connected: boolean }>("peers/check", { publicKey: offer.publicKey });
        if (!stopped && done) setConnected(true);
      } catch {
        /* keep waiting */
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    let timer = setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [offer, connected]);

  const close = () => {
    // Gave up before the other side verified: do not keep trusting it.
    if (offer && !connected) void nexRequest("peers/cancel", { publicKey: offer.publicKey }).catch(() => {});
    onClose(connected);
  };

  return (
    <Dialog title={t("devices.link.connectTitle")} onClose={close}>
      {!offer && !deviceId && (
        <>
          <label className="ms-field">
            <span>{t("devices.link.enterAuthCode")}</span>
            <textarea
              {...textInputProps}
              className="ms-mono link-authcode-input"
              rows={3}
              autoFocus
              placeholder="termany1.…"
              value={authCode}
              onChange={(e) => setAuthCode(e.target.value)}
            />
          </label>
          <p className="ms-hint">{t("devices.link.authCodeHint")}</p>
        </>
      )}
      {!offer && deviceId && busy && <p className="ms-hint">{t("devices.link.contacting")}</p>}
      {offer && !connected && (
        <>
          <p className="ms-hint">{t("devices.link.goVerify", { name: offer.name })}</p>
          <div className="devices-code link-code">{offer.code}</div>
          <p className="ms-hint link-waiting">{t("devices.link.waiting", { name: offer.name })}</p>
        </>
      )}
      {connected && offer && <p className="link-success">✓ {t("devices.link.connected", { name: offer.name })}</p>}
      {error && <ErrorLine error={error} />}
      <div className="ws-dialog-actions">
        {connected ? (
          <button type="button" className="ws-dialog-btn primary" autoFocus onClick={() => onClose(true)}>
            {t("devices.link.done")}
          </button>
        ) : (
          <>
            <button type="button" className="ws-dialog-btn" onClick={close}>
              {t("devices.cancel")}
            </button>
            {!offer && !deviceId && (
              <button
                type="button"
                className="ws-dialog-btn primary"
                disabled={busy || !authCode.trim()}
                onClick={() => void submit(() => nexRequest<PairingOffer>("peers/connect", { code: authCode }))}
              >
                {t("devices.link.next")}
              </button>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Step 2, on the device being connected to: type the code the other screen shows. */
export function VerifyDialog({ onClose }: { onClose: (connected: boolean) => void }) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      setName((await nexRequest<{ name: string }>("peers/verify", { code })).name);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t("devices.link.verifyTitle")} onClose={() => onClose(name !== null)}>
      {name === null ? (
        <label className="ms-field">
          <span>{t("devices.link.enterCode")}</span>
          <input
            {...textInputProps}
            className="ms-mono link-code-input"
            autoFocus
            placeholder="XXXX-XXXX"
            maxLength={12}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && code.trim() && !busy) void verify();
            }}
          />
        </label>
      ) : (
        <p className="link-success">✓ {t("devices.link.connected", { name })}</p>
      )}
      {error && <ErrorLine error={error} />}
      <div className="ws-dialog-actions">
        {name === null ? (
          <>
            <button type="button" className="ws-dialog-btn" onClick={() => onClose(false)}>
              {t("devices.cancel")}
            </button>
            <button
              type="button"
              className="ws-dialog-btn primary"
              disabled={busy || !code.trim()}
              onClick={() => void verify()}
            >
              {t("devices.link.verifyAction")}
            </button>
          </>
        ) : (
          <button type="button" className="ws-dialog-btn primary" autoFocus onClick={() => onClose(true)}>
            {t("devices.link.done")}
          </button>
        )}
      </div>
    </Dialog>
  );
}
