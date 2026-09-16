import { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { useNativeOccluder } from "../nativeViewOcclusion";
import { agentActivityTitle } from "../terminal/manager";
import { trackCloseConfirmClosed, trackCloseConfirmOpened, type CloseTargetKind } from "../closeGuard";

/**
 * Confirms closing a tab, page, or pane that still holds working (yellow) or
 * errored (red) agent panes. Same shell as the workspace/agent delete
 * confirms: backdrop click or Escape cancels, the destructive button stays
 * focused so Enter confirms.
 *
 * Portaled to document.body: three of the four call sites sit inside drag or
 * stacking contexts (pane header, tab strip, tree row) that would otherwise
 * trap the backdrop or steal its pointer events for a drag.
 */
export function CloseConfirm({
  kind,
  name,
  working,
  error,
  onConfirm,
  onClose,
}: {
  kind: CloseTargetKind;
  name: string;
  working: number;
  error: number;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  // One occluder registration per mounted dialog — a shared id would let one
  // dialog's unmount unregister another's while it is still open.
  const occluderId = `close-confirm-${useId()}`;
  const backdropRef = useNativeOccluder<HTMLDivElement>(occluderId);

  useEffect(() => {
    trackCloseConfirmOpened();
    return () => trackCloseConfirmClosed();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="ws-dialog-backdrop" ref={backdropRef} onClick={onClose}>
      <div
        className="ws-dialog agent-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="quit-confirm-text">{t(`closeConfirm.${kind}`, { name })}</p>
        <p className="close-confirm-reason">
          <span className="close-confirm-counts">
            {working > 0 && (
              <span
                className="tree-count activity-count"
                title={`${agentActivityTitle({ status: "working", updatedAt: 0 })} (${working})`}
              >
                <span className="agent-dot working" />
                {working}
              </span>
            )}
            {error > 0 && (
              <span
                className="tree-count activity-count"
                title={`${agentActivityTitle({ status: "error", updatedAt: 0 })} (${error})`}
              >
                <span className="agent-dot error" />
                {error}
              </span>
            )}
          </span>
          {t("closeConfirm.reason")}
        </p>
        <div className="ws-dialog-actions">
          <button className="ws-dialog-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="ws-dialog-btn danger" autoFocus onClick={onConfirm}>
            {t(kind === "page" ? "common.delete" : "common.close")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
