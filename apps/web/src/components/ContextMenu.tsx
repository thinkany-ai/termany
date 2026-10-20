import { type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const MENU_WIDTH = 180;
const MENU_ITEM_HEIGHT = 34;
const MENU_MARGIN = 8;

export type ContextMenuPos = { x: number; y: number };

/** Where to open a context menu of `items` rows: at the cursor, kept inside
 *  the window. */
export function contextMenuPos(e: ReactMouseEvent, items: number): ContextMenuPos {
  const height = items * MENU_ITEM_HEIGHT + 24; // padding + a separator
  return {
    x: Math.max(MENU_MARGIN, Math.min(e.clientX, window.innerWidth - MENU_WIDTH - MENU_MARGIN)),
    y: Math.max(MENU_MARGIN, Math.min(e.clientY, window.innerHeight - height - MENU_MARGIN)),
  };
}

/**
 * Right-click menu for a sidebar row or tab, in the agent list's menu style.
 * Dismissed by any outside click, Esc, scroll, resize or window blur.
 * Portaled to document.body so drag/stacking contexts can't clip it.
 */
export function ContextMenu({
  pos,
  onDismiss,
  children,
}: {
  pos: ContextMenuPos;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    const close = () => dismissRef.current();
    const closeOutside = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close();
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
    };
  }, []);

  return createPortal(
    <div
      ref={menuRef}
      className="agent-context-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}
