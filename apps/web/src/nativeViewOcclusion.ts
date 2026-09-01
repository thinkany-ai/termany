/**
 * Registry of screen rects that should temporarily hide any native child
 * webview (web/office preview panes) they overlap. Those panes are separate
 * OS-level views that always paint above regular DOM content, so a floating
 * popup positioned on top of one needs an explicit rect here instead of
 * relying on CSS z-index, which native views ignore.
 *
 * Rect-scoped rather than a single global "suppress everything" flag: a
 * small dropdown menu should only blank the pane(s) it actually covers, not
 * every web/office preview pane in the workspace.
 */

import { useEffect, useRef } from "react";

export interface OcclusionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const OCCLUSION_CHANGED_EVENT = "termany:native-view-occlusion-changed";

const occluders = new Map<string, OcclusionRect>();

/** Panes don't poll this registry — they listen for this event and re-sync. */
export function subscribeOcclusionChanged(listener: () => void): () => void {
  window.addEventListener(OCCLUSION_CHANGED_EVENT, listener);
  return () => window.removeEventListener(OCCLUSION_CHANGED_EVENT, listener);
}

export function registerOccluder(id: string, rect: OcclusionRect) {
  occluders.set(id, rect);
  window.dispatchEvent(new Event(OCCLUSION_CHANGED_EVENT));
}

export function unregisterOccluder(id: string) {
  if (!occluders.delete(id)) return;
  window.dispatchEvent(new Event(OCCLUSION_CHANGED_EVENT));
}

/**
 * For modal dialogs: registers the referenced element (the backdrop, so the
 * shaded region is what blanks native views) as an occluder while `active`,
 * unregisters on close/unmount. Any dialog that can overlap a web/office
 * preview pane needs this — without it the native view paints over the dialog
 * and swallows its clicks, z-index notwithstanding.
 */
export function useNativeOccluder<T extends HTMLElement>(id: string, active = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const sync = () => registerOccluder(id, el.getBoundingClientRect());
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    sync();
    return () => {
      observer.disconnect();
      unregisterOccluder(id);
    };
  }, [id, active]);
  return ref;
}

function intersects(a: OcclusionRect, b: OcclusionRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Whether `rect` overlaps any currently registered occluder. A native
 * webview can only be shown or hidden as a whole (no partial clipping
 * without resizing it, which reflows the page inside — worse than a brief
 * blank), so this is a plain boolean: the pane(s) actually under a popup go
 * blank for as long as it's open, everything else stays untouched.
 */
export function isRectOccluded(rect: OcclusionRect): boolean {
  for (const occluder of occluders.values()) {
    if (intersects(occluder, rect)) return true;
  }
  return false;
}
