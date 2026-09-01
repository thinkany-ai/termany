#!/usr/bin/env node
// Renders one preview image per built-in theme into docs/themes/, for the table
// in README.md. Re-run it whenever a theme is added or its colors change:
//
//   node scripts/theme-previews.mjs
//
// Each card is a miniature of the app — the same class names, drawn from the
// theme's own tokens — so a theme that ships a stylesheet for chrome its tokens
// can't carry (win98.css) styles the card too, exactly as it styles the app.
//
// Run it after `npm install`: it needs esbuild (a root devDependency) to read
// the theme files, and Chrome to rasterize them. ESBUILD and CHROME override
// either binary.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THEME_DIR = path.join(ROOT, "apps/web/src/themes");
const OUT_DIR = path.join(ROOT, "docs/themes");
const ESBUILD = process.env.ESBUILD ?? path.join(ROOT, "node_modules/.bin/esbuild");
const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Card size in CSS pixels — the card uses the app's real lengths, at 1x. */
const W = 720;
const H = 310;
/** Rasterized at 2x, then stored at this width: still 2x a README table cell. */
const SCALE = 2;
const STORED_WIDTH = 800;

/** Modules in themes/ that are machinery, not themes. */
const NOT_A_THEME = new Set(["index.ts", "types.ts", "codex-import.ts", "codex-listings.ts", "codex-packs.ts"]);

/** xterm.js falls back to this palette for any ANSI slot a theme leaves unset. */
const XTERM_DEFAULTS = {
  background: "#000000",
  foreground: "#ffffff",
  cursor: "#ffffff",
  black: "#2e3436",
  red: "#cc0000",
  green: "#4e9a06",
  yellow: "#c4a000",
  blue: "#3465a4",
  magenta: "#75507b",
  cyan: "#06989a",
  white: "#d3d7cf",
  brightBlack: "#555753",
  brightRed: "#ef2929",
  brightGreen: "#8ae234",
  brightYellow: "#fce94f",
  brightBlue: "#729fcf",
  brightMagenta: "#ad7fa8",
  brightCyan: "#34e2e2",
  brightWhite: "#eeeeec",
};

/** Read every theme object out of themes/*.ts, via a bundled throwaway entry. */
function readThemes(tmp) {
  const files = readdirSync(THEME_DIR).filter((f) => f.endsWith(".ts") && !NOT_A_THEME.has(f));
  const entry = path.join(tmp, "entry.ts");
  writeFileSync(
    entry,
    files.map((f, i) => `import * as m${i} from ${JSON.stringify(path.join(THEME_DIR, f))};`).join("\n") +
      `\nconst mods = [${files.map((_, i) => `m${i}`).join(", ")}];\n` +
      `const themes = mods.flatMap((m) => Object.values(m)).filter((t) => t && t.id && t.term);\n` +
      `console.log(JSON.stringify(themes));\n`,
  );
  const bundle = path.join(tmp, "themes.mjs");
  // A theme's stylesheet is inlined into the card separately, below.
  execFileSync(ESBUILD, [entry, "--bundle", "--platform=node", "--format=esm", "--loader:.css=text", `--outfile=${bundle}`, "--log-level=error"]);
  return JSON.parse(execFileSync(process.execPath, [bundle], { encoding: "utf8" }));
}

/** The stylesheet themes/<id>.ts imports, if any. */
function themeCss(id) {
  const source = path.join(THEME_DIR, `${id}.ts`);
  let src;
  try {
    src = readFileSync(source, "utf8");
  } catch {
    return "";
  }
  const rel = /^\s*import\s+["'](\.\/[^"']+\.css)["']/m.exec(src)?.[1];
  return rel ? readFileSync(path.join(THEME_DIR, rel), "utf8") : "";
}

/** Relative luminance of a #rgb / #rrggbb color; null for anything else. */
function luminance(color) {
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(String(color).trim())?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((h) => h + h).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Whichever of `a`/`b` stands out against `on`. Falls back to `a`. */
function readable(on, a, b) {
  const base = luminance(on);
  const la = luminance(a);
  const lb = luminance(b);
  if (base === null || la === null || lb === null) return a;
  return Math.abs(la - base) >= Math.abs(lb - base) ? a : b;
}

function card(t) {
  const c = t.colors;
  const term = { ...XTERM_DEFAULTS, ...t.term };
  const topBar = t.chrome?.topBar ?? c.bg2;
  const topBarBorder = t.chrome?.topBarBorder ?? c.border;
  const activeTab = t.chrome?.activeTab ?? c.bg;
  const activeRow = t.chrome?.activeRow ?? c.bg3;
  const sideBg = t.sidebar?.bg ?? c.bg2;
  const sideBorder = t.sidebar?.border ?? c.border;
  const paneGap = t.chrome?.paneGap ?? "8px";
  const paneRadius = t.chrome?.paneRadius ?? t.radius.lg;
  const paneBorder = t.chrome?.paneBorder ?? c.border;
  const paneShadow = t.chrome?.paneShadow ?? "0 2px 10px rgba(0,0,0,0.18)";
  // The surface a pane floats on. A theme can repaint it through vars.
  const paneArea = t.vars?.["--pane-area-bg"] ?? t.vars?.["pane-area-bg"] ?? c.bg;
  // An active row can be a solid accent (win98's navy), so its label has to
  // take whichever side of the theme stays legible on it.
  const activeRowFg = readable(activeRow, c.fg, c.bg);
  const prompt = `<span style="color:${term.green}">→</span>  <span style="color:${term.cyan}">termany</span> <span style="color:${term.blue}">git:(</span><span style="color:${term.red}">main</span><span style="color:${term.blue}">)</span> <span style="color:${term.yellow}">✗</span>`;

  return `<!doctype html>
<html data-theme="${t.id}">
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; }
  body {
    background: ${c.bg}; color: ${c.fg}; overflow: hidden;
    font: 13px/1.4 -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif;
  }
  .app { height: 100%; display: flex; flex-direction: column; }
  .htabbar {
    height: 46px; flex: none; display: flex; align-items: center; gap: 12px;
    padding: 0 14px; background: ${topBar}; border-bottom: 1px solid ${topBarBorder};
  }
  .lights { display: flex; gap: 7px; }
  .lights i { width: 11px; height: 11px; border-radius: 50%; background: ${c.fgDim}; opacity: .5; }
  .ws-switcher { display: flex; align-items: center; gap: 7px; }
  .ws-name { font-weight: 600; }
  .htab-strip { display: flex; align-items: center; gap: 5px; height: 100%; margin-left: 8px; }
  .htab {
    display: flex; align-items: center; padding: 5px 13px; font-size: 12px;
    border-radius: ${t.radius.md}; color: ${c.fgDim};
  }
  .htab.active { background: ${activeTab}; color: ${c.fg}; }
  .main { flex: 1; display: flex; min-height: 0; }
  .sidebar {
    width: 150px; flex: none; background: ${sideBg};
    border-right: 1px solid ${sideBorder}; padding: 12px 8px;
    display: flex; flex-direction: column;
  }
  .section-title {
    font-size: 10px; letter-spacing: .12em; font-weight: 600;
    color: ${c.fgDim}; padding: 0 7px 7px;
  }
  .tree { display: flex; flex-direction: column; gap: 3px; }
  .tree-row {
    display: flex; align-items: center; gap: 6px; padding: 6px 7px; font-size: 12px;
    border-radius: ${t.radius.md}; color: ${c.fgDim};
  }
  .tree-row.active { background: ${activeRow}; color: ${activeRowFg}; }
  .tree-dot { width: 7px; height: 7px; border-radius: 50%; background: ${c.accent}; margin-left: auto; }
  .pane-card { flex: 1; min-width: 0; display: flex; padding: ${paneGap}; background: ${paneArea}; }
  .pane-slot {
    flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden;
    background: ${term.background}; border: 1px solid ${paneBorder};
    border-radius: ${paneRadius}; box-shadow: ${paneShadow};
  }
  .pane-head {
    height: 33px; flex: none; display: flex; align-items: center; justify-content: space-between;
    padding: 0 12px; font-size: 11px; background: ${c.bg2}; color: ${c.fgDim};
    border-bottom: 1px solid ${c.border};
  }
  .pane-head-title { color: ${c.fg}; font-weight: 600; }
  .pane-body { flex: 1; min-height: 0; display: flex; }
  .term-pane { flex: 1; min-width: 0; background: ${term.background}; overflow: hidden; }
  pre {
    padding: 11px 13px; color: ${term.foreground}; white-space: pre;
    font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .cur { background: ${term.cursor}; color: ${term.background}; }
</style>
<style>${themeCss(t.id)}</style>
<body>
<div id="root" class="app">
  <div class="htabbar">
    <span class="lights"><i></i><i></i><i></i></span>
    <span class="ws-switcher"><span class="ws-name">workspace</span></span>
    <span class="htab-strip"><span class="htab active">tab 1</span><span class="htab">tab 2</span><span class="htab">tab 3</span></span>
  </div>
  <div class="main">
    <div class="sidebar">
      <div class="section-title">PAGES</div>
      <div class="tree">
        <div class="tree-row">termany</div>
        <div class="tree-row active">agent<span class="tree-dot"></span></div>
        <div class="tree-row">remote_dev</div>
        <div class="tree-row">local_dev</div>
      </div>
    </div>
    <div class="pane-card">
      <div class="pane-slot focused">
        <div class="pane-head"><span class="pane-head-title">${t.name}</span><span>${t.appearance}</span></div>
        <div class="pane-body">
          <div class="term-pane">
<pre>${prompt} ls
<span style="color:${term.brightBlue}">apps</span>       <span style="color:${term.brightBlue}">docs</span>       <span style="color:${term.brightBlue}">packages</span>
README.md  LICENSE    package.json

${prompt} npm test
  <span style="color:${term.green}">✓ 128 passed</span>   <span style="color:${term.yellow}">⚠ 2 skipped</span>   <span style="color:${term.magenta}">1 flaky</span>

${prompt} <span class="cur">&nbsp;</span></pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>`;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "termany-themes-"));
try {
  mkdirSync(OUT_DIR, { recursive: true });
  const themes = readThemes(tmp);
  for (const t of themes) {
    const html = path.join(tmp, `${t.id}.html`);
    const png = path.join(OUT_DIR, `${t.id}.png`);
    writeFileSync(html, card(t));
    execFileSync(CHROME, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--force-device-scale-factor=${SCALE}`,
      `--screenshot=${png}`,
      `--window-size=${W},${H}`,
      html,
    ], { stdio: "ignore" });
    execFileSync("sips", ["-Z", String(STORED_WIDTH), png], { stdio: "ignore" });
    console.log(`docs/themes/${t.id}.png  ${t.name}`);
  }
  console.log(`\n${themes.length} themes rendered.`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
