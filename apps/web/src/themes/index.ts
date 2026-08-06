import { applyTermTheme } from "../terminal/manager";
import { aurora } from "./aurora";
import { charcoal } from "./charcoal";
import { codex } from "./codex";
import { daylight } from "./daylight";
import { defaultDark } from "./default-dark";
import { gruvbox } from "./gruvbox";
import { gruvboxLight } from "./gruvbox-light";
import { horizon } from "./horizon";
import { meadow } from "./meadow";
import { phosphor } from "./phosphor";
import { rosePine } from "./rose-pine";
import { rosePineDawn } from "./rose-pine-dawn";
import { solarizedDark } from "./solarized-dark";
import type { Theme } from "./types";
import { win98 } from "./win98";

export type { Theme };
export { fromCodexTheme, isCodexTheme } from "./codex-import";

/**
 * The registry. To add a theme — built-in or AI-generated — author a Theme
 * object (see ./types.ts) in its own file and append it here. Nothing else
 * needs to change: the picker, persistence, and applyTheme() are all generic.
 */
export const THEMES: Theme[] = [
  defaultDark,
  solarizedDark,
  daylight,
  meadow,
  charcoal,
  gruvbox,
  gruvboxLight,
  rosePine,
  rosePineDawn,
  aurora,
  horizon,
  phosphor,
  codex,
  win98,
];

/** The bundled themes, i.e. THEMES minus anything registered at runtime. */
export const BUILT_IN_THEMES: readonly Theme[] = [...THEMES];

// Codex is the out-of-the-box look for a fresh install. Anyone who has already
// picked a theme keeps it — loadThemeId() only falls back here when nothing is
// stored.
export const DEFAULT_THEME_ID = "codex";
const STORAGE_KEY = "termany.theme";
const AI_THEMES_KEY = "termany.aiThemes";

export function getTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** Cheap shape check for a Theme coming from the server / localStorage. */
function isTheme(t: unknown): t is Theme {
  const x = t as Theme;
  return (
    !!x &&
    typeof x.id === "string" &&
    typeof x.name === "string" &&
    (x.appearance === "dark" || x.appearance === "light") &&
    !!x.colors?.bg &&
    !!x.radius?.md &&
    !!x.term?.background
  );
}

/**
 * Add a theme to the registry at runtime (AI-generated or hand-edited, see
 * Settings). Replaces any existing theme with the same id. User-authored
 * themes (id prefixed "ai-" or "custom-") are persisted so they survive a
 * reload. Returns the theme on success.
 */
export function registerTheme(theme: unknown): Theme {
  if (!isTheme(theme)) throw new Error("invalid theme");
  const i = THEMES.findIndex((t) => t.id === theme.id);
  if (i >= 0) THEMES[i] = theme;
  else THEMES.push(theme);
  return theme;
}

/**
 * One-time cleanup of the pre-6.0 theme store. Themes authored in the removed
 * in-app editor (and Codex packs that older builds copied here) are dropped:
 * a stored id that no longer resolves falls back to DEFAULT_THEME_ID.
 */
export function loadAiThemes() {
  try {
    localStorage.removeItem(AI_THEMES_KEY);
  } catch {
    /* ignore */
  }
}

/** The raw persisted id, before it is checked against the registry. */
export function storedThemeId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The persisted theme id, or the default when nothing's stored / unavailable. */
export function loadThemeId(): string {
  try {
    const id = localStorage.getItem(STORAGE_KEY);
    if (id && THEMES.some((t) => t.id === id)) return id;
  } catch {
    /* localStorage blocked (private mode etc.) — fall through */
  }
  return DEFAULT_THEME_ID;
}

/**
 * "#rgb"/"#rrggbb" → "rgba(r, g, b, alpha)". Anything else (gradients, an
 * already-translucent rgba(), a named color) is returned unchanged — safer
 * than mis-blending a format we don't understand.
 */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const hex = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Keys the escape-hatch `vars` loop set on the PREVIOUS applyThemeObject call —
// cleared up front so a var a theme doesn't mention (e.g. Codex's
// --pane-focus-ring) doesn't leak into the next theme applied after it.
let lastCustomVarKeys: string[] = [];

/** Apply a theme's CSS vars + terminal palette, without touching persistence. */
function applyThemeObject(theme: Theme) {
  const root = document.documentElement;
  const { colors, radius } = theme;

  for (const k of lastCustomVarKeys) root.style.removeProperty(k);

  root.style.setProperty("--bg", colors.bg);
  root.style.setProperty("--bg-2", colors.bg2);
  root.style.setProperty("--bg-3", colors.bg3);
  root.style.setProperty("--border", colors.border);
  root.style.setProperty("--fg", colors.fg);
  root.style.setProperty("--fg-dim", colors.fgDim);
  root.style.setProperty("--accent", colors.accent);
  root.style.setProperty("--accent-soft", colors.accentSoft);
  root.style.setProperty("--radius-sm", radius.sm);
  root.style.setProperty("--radius-md", radius.md);
  root.style.setProperty("--radius-lg", radius.lg);
  // A 1px border whose color is "transparent"/"none" still occupies a pixel and
  // shows what's behind it as a hairline — so collapse those to zero width.
  const borderRule = (color: string | undefined, fallback: string) => {
    const c = color ?? fallback;
    return c === "transparent" || c === "none" ? "0 solid transparent" : `1px solid ${c}`;
  };

  // A background image shows through the pane gaps + sidebar/top bar, which
  // get alpha-blended below; the terminal panes (--bg) stay fully opaque on
  // purpose (see the `background` field's doc comment in themes/types.ts).
  const bgImage = theme.background?.image;
  const opacity = theme.background?.opacity ?? 1;
  const blend = (c: string) => (bgImage ? withAlpha(c, opacity) : c);

  root.style.setProperty("--bg-image", bgImage ? `url("${bgImage}")` : "none");
  root.style.setProperty("--pane-area-bg", blend(colors.bg2));
  root.style.setProperty("--sidebar-bg", blend(theme.sidebar?.bg ?? colors.bg2));
  root.style.setProperty("--sidebar-border", borderRule(theme.sidebar?.border, colors.border));
  root.style.setProperty("--top-bar", blend(theme.chrome?.topBar ?? colors.bg2));
  root.style.setProperty("--top-bar-border", borderRule(theme.chrome?.topBarBorder, colors.border));
  root.style.setProperty("--active-tab", theme.chrome?.activeTab ?? colors.bg);
  root.style.setProperty("--active-row", theme.chrome?.activeRow ?? colors.bg3);
  const paneGap = theme.chrome?.paneGap ?? "5px";
  root.style.setProperty("--pane-gap", paneGap);
  // Flush themes (no gap between panes) have no visible seam of their own, so
  // the split gutter draws the hairline instead. Themes with a gap don't: the
  // pane cards' own borders separate them, and a line in the gap would double up.
  root.style.setProperty("--split-gutter-line", parseFloat(paneGap) === 0 ? colors.border : "transparent");
  root.style.setProperty("--pane-radius", theme.chrome?.paneRadius ?? radius.lg);
  root.style.setProperty("--pane-border", borderRule(theme.chrome?.paneBorder, colors.border));
  // Kept tight on purpose: it's a per-pane shadow, and a wide blur bleeds
  // across the split gutter onto the neighbouring pane. See styles.css.
  root.style.setProperty("--pane-shadow", theme.chrome?.paneShadow ?? "0 1px 2px rgba(0, 0, 0, 0.05)");
  // Escape hatch: arbitrary CSS-var overrides, applied last so they win.
  lastCustomVarKeys = Object.keys(theme.vars ?? {}).map((k) => (k.startsWith("--") ? k : `--${k}`));
  for (const [k, v] of Object.entries(theme.vars ?? {})) {
    root.style.setProperty(k.startsWith("--") ? k : `--${k}`, v);
  }
  root.dataset.appearance = theme.appearance;
  // A theme whose look needs more than the flat tokens (Windows 98's 3D bevels,
  // say) ships its own stylesheet scoped to html[data-theme="<id>"]. Every other
  // theme just leaves that attribute unmatched.
  root.dataset.theme = theme.id;

  applyTermTheme(theme.term);
}

/** Apply a theme everywhere (CSS vars + all terminals) and persist the choice. */
export function applyTheme(id: string) {
  applyThemeObject(getTheme(id));
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore persistence failure */
  }
}

/**
 * Live-preview an in-progress theme edit (the theme editor calls this on
 * every keystroke) without registering or persisting it — the caller is
 * responsible for reverting via `applyTheme(activeId)` if the edit is
 * cancelled.
 */
export function previewTheme(theme: Theme) {
  applyThemeObject(theme);
}
