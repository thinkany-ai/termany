import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { registerOccluder, unregisterOccluder } from "../nativeViewOcclusion";
import { loadKeybindings, matchChord } from "../keybindings";
import { popoverPosition } from "../popoverPosition";

/** Portaled pane popups share viewport placement, dismissal, and occlusion. */
export const HEADER_POPOVER_STYLE = {
  position: "fixed", right: "auto", bottom: "auto", zIndex: 50,
  overflowY: "auto", overscrollBehavior: "contain",
} as const;

export function usePaneHeadPopover(open: boolean, close: () => void, align: "left" | "right" = "right") {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const occluderId = useId();

  useEffect(() => {
    if (!open) return;
    const onClick = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node) && !panelRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      // App shortcuts dismiss the popup; ordinary copy/paste/select-all must
      // keep the SSH field open. Respect customized bindings as well.
      if (event.metaKey || event.ctrlKey || event.altKey) {
        if (Object.values(loadKeybindings()).some((chord) => matchChord(event, chord))) close();
        return;
      }
      if (panelRef.current?.getAttribute("role") === "menu" &&
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const items = Array.from(panelRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
          (current < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1) :
            (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
        items[next].focus({ preventScroll: true });
        items[next].scrollIntoView({ block: "nearest" });
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      rootRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      close();
    };
    window.addEventListener("click", onClick);
    window.addEventListener("focusin", onClick);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("focusin", onClick);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  // Portal panels escape pane overflow/containment and zen transforms. Track
  // both geometry and the native-view occlusion rectangle after positioning.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!open || !root || !panel) return;
    let raf = 0;
    let lastRect = "";
    const position = () => {
      panel.style.maxWidth = `${Math.max(0, window.innerWidth - 16)}px`;
      const p = popoverPosition(root.getBoundingClientRect(), {
        width: panel.getBoundingClientRect().width,
        height: panel.scrollHeight + panel.offsetHeight - panel.clientHeight,
      }, { width: innerWidth, height: innerHeight }, align);
      Object.assign(panel.style, { left: `${p.left}px`, top: `${p.top}px`, maxHeight: `${p.maxHeight}px` });
      const rect = panel.getBoundingClientRect();
      const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
      if (key !== lastRect) {
        lastRect = key;
        registerOccluder(occluderId, rect);
      }
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(position);
    };
    position();
    if (panel.getAttribute("role") === "menu") {
      panel.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    }
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    const pane = root.closest(".pane-slot");
    if (pane) resize.observe(pane);
    resize.observe(panel);
    const theme = new MutationObserver(schedule);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      theme.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      unregisterOccluder(occluderId);
    };
  }, [open, occluderId, align]);

  return { rootRef, panelRef };
}

