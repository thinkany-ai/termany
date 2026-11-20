/**
 * Customizable keyboard shortcuts.
 *
 * Every global shortcut is an "action" with a default chord. The user can
 * rebind any action from Settings → Keyboard; overrides are persisted to
 * localStorage and merged over the defaults on load (so new actions shipped in
 * a later build still show up with their default binding).
 *
 * Chords match on `KeyboardEvent.code` (the physical key, layout-independent)
 * plus an EXACT set of modifiers — unlike a fuzzy match, ⌘T and ⌘⌥T are
 * distinct, which is what makes rebinding predictable.
 */

import { isTauri } from "./env";

/** A single key combination. `code` is a KeyboardEvent.code (e.g. "KeyT"). */
export interface Chord {
  code: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** Logical groups, used to section the Settings list. */
export type ActionGroup = "Tabs & panes" | "Navigation" | "Appearance" | "General";

export interface ActionDef {
  id: string;
  label: string;
  group: ActionGroup;
  default: Chord;
  /**
   * Keep this action out of the ⌘P command palette. For the handful that only
   * make sense as a chord: opening the palette from inside itself, and the nine
   * switch-to-tab-N entries, which would otherwise crowd out real results.
   * Still fully bindable and listed in Settings → Keyboard.
   */
  hideInPalette?: true;
  /**
   * Drop the action entirely outside the desktop shell — for the ones with
   * nothing to act on in a browser tab, where the OS chrome isn't ours. Unlike
   * `hideInPalette` this also unbinds the chord and hides the Settings row.
   */
  desktopOnly?: true;
}

/** The platform's conventional application-shortcut modifier. */
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Action definitions are written in the macOS notation used by the original
 * catalog. Translate Command to Control elsewhere. A macOS Control+Command
 * chord becomes Control+Alt on Windows/Linux so the two distinct modifiers do
 * not collapse into one key.
 */
export function chordForPlatform(chord: Chord, isMac = IS_MAC): Chord {
  if (isMac || !chord.meta) return { ...chord };
  return {
    ...chord,
    meta: undefined,
    ctrl: true,
    alt: chord.alt || chord.ctrl || undefined,
  };
}

/**
 * The catalog of bindable actions. The dispatch behaviour for each id lives in
 * App.tsx (keeps this module free of any store/UI coupling). To add a shortcut:
 * append an entry here and a matching case in App.tsx's handler map.
 */
const ACTION_DEFINITIONS: ActionDef[] = [
  { id: "newTab", label: "New terminal tab", group: "Tabs & panes", default: { code: "KeyT", meta: true } },
  { id: "closePane", label: "Close pane / tab", group: "Tabs & panes", default: { code: "KeyW", meta: true } },
  { id: "splitRight", label: "Split right", group: "Tabs & panes", default: { code: "KeyD", meta: true } },
  { id: "splitDown", label: "Split down", group: "Tabs & panes", default: { code: "KeyD", meta: true, shift: true } },
  { id: "toggleMaximize", label: "Maximize / restore pane", group: "Tabs & panes", default: { code: "KeyM", meta: true } },
  { id: "retilePanes", label: "Cycle pane layout", group: "Tabs & panes", default: { code: "KeyE", meta: true, shift: true } },
  // Directional pane focus / resize — the chords iTerm2 and Warp both use.
  { id: "focusPaneLeft", label: "Focus pane left", group: "Tabs & panes", default: { code: "ArrowLeft", meta: true, alt: true } },
  { id: "focusPaneRight", label: "Focus pane right", group: "Tabs & panes", default: { code: "ArrowRight", meta: true, alt: true } },
  { id: "focusPaneUp", label: "Focus pane above", group: "Tabs & panes", default: { code: "ArrowUp", meta: true, alt: true } },
  { id: "focusPaneDown", label: "Focus pane below", group: "Tabs & panes", default: { code: "ArrowDown", meta: true, alt: true } },
  { id: "resizePaneLeft", label: "Move divider left", group: "Tabs & panes", default: { code: "ArrowLeft", meta: true, ctrl: true } },
  { id: "resizePaneRight", label: "Move divider right", group: "Tabs & panes", default: { code: "ArrowRight", meta: true, ctrl: true } },
  { id: "resizePaneUp", label: "Move divider up", group: "Tabs & panes", default: { code: "ArrowUp", meta: true, ctrl: true } },
  { id: "resizePaneDown", label: "Move divider down", group: "Tabs & panes", default: { code: "ArrowDown", meta: true, ctrl: true } },
  { id: "togglePaneView", label: "Cycle visible pane views", group: "Tabs & panes", default: { code: "KeyE", meta: true } },
  { id: "zoomTerminalIn", label: "Increase terminal text size", group: "Appearance", default: { code: "Equal", meta: true, shift: true } },
  { id: "zoomTerminalOut", label: "Decrease terminal text size", group: "Appearance", default: { code: "Minus", meta: true } },
  { id: "resetTerminalZoom", label: "Reset terminal text size", group: "Appearance", default: { code: "Digit0", meta: true } },
  { id: "clearScreen", label: "Clear terminal", group: "Tabs & panes", default: { code: "KeyK", meta: true } },
  { id: "clearAllPanes", label: "Clear every terminal in tab", group: "Tabs & panes", default: { code: "KeyK", meta: true, shift: true } },
  { id: "nextTab", label: "Next tab", group: "Tabs & panes", default: { code: "BracketRight", meta: true, shift: true } },
  { id: "prevTab", label: "Previous tab", group: "Tabs & panes", default: { code: "BracketLeft", meta: true, shift: true } },
  { id: "switchTab1", label: "Switch to tab 1", group: "Tabs & panes", default: { code: "Digit1", meta: true }, hideInPalette: true },
  { id: "switchTab2", label: "Switch to tab 2", group: "Tabs & panes", default: { code: "Digit2", meta: true }, hideInPalette: true },
  { id: "switchTab3", label: "Switch to tab 3", group: "Tabs & panes", default: { code: "Digit3", meta: true }, hideInPalette: true },
  { id: "switchTab4", label: "Switch to tab 4", group: "Tabs & panes", default: { code: "Digit4", meta: true }, hideInPalette: true },
  { id: "switchTab5", label: "Switch to tab 5", group: "Tabs & panes", default: { code: "Digit5", meta: true }, hideInPalette: true },
  { id: "switchTab6", label: "Switch to tab 6", group: "Tabs & panes", default: { code: "Digit6", meta: true }, hideInPalette: true },
  { id: "switchTab7", label: "Switch to tab 7", group: "Tabs & panes", default: { code: "Digit7", meta: true }, hideInPalette: true },
  { id: "switchTab8", label: "Switch to tab 8", group: "Tabs & panes", default: { code: "Digit8", meta: true }, hideInPalette: true },
  { id: "switchTab9", label: "Switch to tab 9", group: "Tabs & panes", default: { code: "Digit9", meta: true }, hideInPalette: true },
  { id: "nextPane", label: "Next pane", group: "Tabs & panes", default: { code: "BracketRight", meta: true } },
  { id: "prevPane", label: "Previous pane", group: "Tabs & panes", default: { code: "BracketLeft", meta: true } },
  { id: "scrollTop", label: "Scroll to top", group: "Navigation", default: { code: "Home", meta: true } },
  { id: "scrollBottom", label: "Scroll to bottom", group: "Navigation", default: { code: "End", meta: true } },
  { id: "previousPage", label: "Previous visible page", group: "Navigation", default: { code: "ArrowUp", meta: true } },
  { id: "nextPage", label: "Next visible page", group: "Navigation", default: { code: "ArrowDown", meta: true } },
  { id: "enterPage", label: "Expand / enter page", group: "Navigation", default: { code: "ArrowRight", meta: true } },
  { id: "exitPage", label: "Collapse / parent page", group: "Navigation", default: { code: "ArrowLeft", meta: true } },
  { id: "newPage", label: "New page", group: "Navigation", default: { code: "KeyN", meta: true } },
  { id: "newChildPage", label: "New child page", group: "Navigation", default: { code: "Enter", meta: true } },
  { id: "newWorkspace", label: "New workspace", group: "Navigation", default: { code: "KeyN", meta: true, shift: true } },
  // ⌘N and ⌘⇧N are already the two entries above, so the third "new" lands on
  // ⌥⌘N. The macOS Window menu deliberately leaves its New Window item without
  // a keyEquivalent so this binding stays the only one, and stays rebindable.
  { id: "newWindow", label: "New window", group: "Navigation", default: { code: "KeyN", meta: true, alt: true }, desktopOnly: true },
  { id: "nextWorkspace", label: "Next workspace", group: "Navigation", default: { code: "BracketRight", meta: true, ctrl: true } },
  { id: "prevWorkspace", label: "Previous workspace", group: "Navigation", default: { code: "BracketLeft", meta: true, ctrl: true } },
  { id: "previousTheme", label: "Previous theme", group: "Appearance", default: { code: "Comma", meta: true, alt: true } },
  { id: "nextTheme", label: "Next theme", group: "Appearance", default: { code: "Period", meta: true, alt: true } },
  // Sits with the two theme-cycling chords above rather than under ⌘⇧, so the
  // whole theme story is on ⌥⌘.
  { id: "openThemePicker", label: "Open theme picker", group: "Appearance", default: { code: "KeyT", meta: true, alt: true } },
  { id: "toggleSidebar", label: "Toggle sidebar", group: "General", default: { code: "KeyB", meta: true } },
  // Mirrors ⌘B for the left sidebar, and matches iTerm2, whose right-hand
  // Toolbelt is also ⌘⇧B.
  { id: "toggleRail", label: "Toggle quick-action panel", group: "General", default: { code: "KeyB", meta: true, shift: true } },
  { id: "openSettings", label: "Open settings", group: "General", default: { code: "Comma", meta: true } },
  { id: "showGitDiff", label: "Show git diff", group: "General", default: { code: "KeyG", meta: true, alt: true } },
  { id: "search", label: "Search pages, tabs & panels", group: "General", default: { code: "KeyP", meta: true }, hideInPalette: true },
  { id: "find", label: "Find in terminal", group: "General", default: { code: "KeyF", meta: true } },
  { id: "findNext", label: "Find next", group: "General", default: { code: "KeyG", meta: true } },
  { id: "findPrev", label: "Find previous", group: "General", default: { code: "KeyG", meta: true, shift: true } },
  // The three side-rail panels. ⌘⇧H is free — macOS only claims ⌘H (hide) and
  // ⌥⌘H (hide others), both of which stay with the native menu.
  { id: "openAgentHistory", label: "Open agent session history", group: "General", default: { code: "KeyH", meta: true, shift: true } },
  { id: "openAgentUsage", label: "Open agent token usage", group: "General", default: { code: "KeyU", meta: true, shift: true } },
  { id: "openSystemMonitor", label: "Open system monitor", group: "General", default: { code: "KeyM", meta: true, shift: true } },
  { id: "handoffAgent", label: "Hand off to another agent", group: "Tabs & panes", default: { code: "KeyA", meta: true, shift: true } },
];

/** Platform-native action catalog consumed by matching, settings and xterm. */
export const ACTIONS: ActionDef[] = ACTION_DEFINITIONS.filter(
  (action) => !action.desktopOnly || isTauri
).map((action) => ({
  ...action,
  default: chordForPlatform(action.default),
}));

/** Codes that are modifiers themselves — never a valid chord on their own. */
const MODIFIER_CODES = new Set([
  "MetaLeft", "MetaRight", "ControlLeft", "ControlRight",
  "ShiftLeft", "ShiftRight", "AltLeft", "AltRight",
]);

const STORAGE_KEY = "termany.keybindings";

/** Default map of action id → chord, derived from ACTIONS. */
export const DEFAULT_KEYBINDINGS: Record<string, Chord> = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a.default])
);

function isChord(c: unknown): c is Chord {
  return !!c && typeof (c as Chord).code === "string";
}

/** Persisted bindings merged over defaults, falling back to defaults entirely. */
export function loadKeybindings(): Record<string, Chord> {
  const map = { ...DEFAULT_KEYBINDINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Record<string, unknown>;
      for (const a of ACTIONS) {
        if (isChord(stored[a.id])) map[a.id] = stored[a.id] as Chord;
      }
    }
  } catch {
    /* localStorage blocked / corrupt — fall back to defaults */
  }
  return map;
}

export function saveKeybindings(map: Record<string, Chord>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore persistence failure */
  }
}

/** Does a keydown event satisfy this chord (exact modifier match)? */
export function matchChord(e: KeyboardEvent, c: Chord): boolean {
  // On macOS, the conventional ⌘+ shortcut is reported inconsistently as
  // either ⌘⇧= or ⌘= depending on keyboard layout/webview. Treat those two
  // event shapes as the same physical shortcut.
  const shiftedPlusAlias = c.code === "Equal" && c.meta && c.shift && e.code === "Equal";
  return (
    e.code === c.code &&
    e.metaKey === !!c.meta &&
    e.ctrlKey === !!c.ctrl &&
    (shiftedPlusAlias || e.shiftKey === !!c.shift) &&
    e.altKey === !!c.alt
  );
}

/** Build a chord from a keydown, or null if only modifiers are held. */
export function chordFromEvent(e: KeyboardEvent): Chord | null {
  if (MODIFIER_CODES.has(e.code)) return null;
  return {
    code: e.code,
    meta: e.metaKey || undefined,
    ctrl: e.ctrlKey || undefined,
    shift: e.shiftKey || undefined,
    alt: e.altKey || undefined,
  };
}

export function chordsEqual(a: Chord, b: Chord): boolean {
  return (
    a.code === b.code &&
    !!a.meta === !!b.meta &&
    !!a.ctrl === !!b.ctrl &&
    !!a.shift === !!b.shift &&
    !!a.alt === !!b.alt
  );
}

/** Human-readable label for a KeyboardEvent.code. */
function codeLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num" + code.slice(6);
  const map: Record<string, string> = {
    Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
    Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]",
    Backquote: "`", Minus: "-", Equal: "=",
    Enter: "↩", Space: "Space", Tab: "⇥", Backspace: "⌫",
    Delete: "⌦", Escape: "Esc",
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  };
  return map[code] ?? code;
}

/** Platform-native display string, e.g. "⌘⇧D" or "Ctrl+Shift+D". */
export function formatChord(c: Chord): string {
  const shiftedPlus = c.shift && c.code === "Equal";
  if (!IS_MAC) {
    const modifiers: string[] = [];
    if (c.ctrl) modifiers.push("Ctrl");
    if (c.alt) modifiers.push("Alt");
    if (c.shift && !shiftedPlus) modifiers.push("Shift");
    if (c.meta) modifiers.push("Win");
    const key = shiftedPlus ? "+" : codeLabel(c.code);
    return modifiers.length ? `${modifiers.join("+")}+${key}` : key;
  }

  let s = "";
  if (c.ctrl) s += "⌃";
  if (c.alt) s += "⌥";
  // The shifted Equal key is conventionally presented as "+" on macOS
  // (⌘+), rather than exposing its physical-key implementation (⇧⌘=).
  if (c.shift && !shiftedPlus) s += "⇧";
  if (c.meta) s += "⌘";
  return s + (shiftedPlus ? "+" : codeLabel(c.code));
}

/**
 * "<label> (<chord>)" for a button's title/tooltip, reading the action's LIVE
 * binding (so a rebind in Settings → Keyboard is reflected immediately,
 * unlike a hardcoded shortcut string baked into the JSX).
 */
export function withShortcut(label: string, actionId: string): string {
  const chord = loadKeybindings()[actionId];
  return chord ? `${label} (${formatChord(chord)})` : label;
}
