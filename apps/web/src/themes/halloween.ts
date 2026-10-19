import type { Theme } from "./types";
// The sidebar scene (pumpkin + light string) is laid out by this stylesheet,
// scoped to html[data-theme="halloween"]. The art is in ./halloween/.
import "./halloween/halloween.css";

// Halloween. A night-purple shell around warm parchment text, with the candle
// orange as the accent. Every surface a sprite sits on is N1 (#110c18) from
// the locked palette (art/README.md, PAL-6), so the pixel art has no seam.
// The terminal palette is checked against real Claude Code and Codex output
// (docs/halloween/README.md).
export const halloween: Theme = {
  id: "halloween",
  name: "Halloween",
  appearance: "dark",
  colors: {
    bg: "#110c18",
    bg2: "#1b1426",
    bg3: "#2a2039",
    border: "#2a2039",
    fg: "#f1e6d6",
    fgDim: "#a99cbd",
    accent: "#ff8a1f",
    accentSoft: "rgba(255, 138, 31, 0.18)",
  },
  radius: { sm: "4px", md: "6px", lg: "8px" },
  sidebar: { bg: "#110c18", border: "#2a2039" },
  chrome: {
    topBar: "#1b1426",
    activeTab: "#110c18",
    activeRow: "#2a2039",
  },
  term: {
    background: "#110c18",
    foreground: "#f1e6d6",
    cursor: "#ff8a1f",
    cursorAccent: "#110c18",
    selectionBackground: "#43365a",
    black: "#2a2039",
    red: "#ff6a5a",
    green: "#7fdc8f",
    yellow: "#ffc14d",
    blue: "#8fa9ff",
    magenta: "#d59cff",
    cyan: "#6fd8cc",
    white: "#e3d6c2",
    brightBlack: "#958aaa",
    brightRed: "#ff8b7d",
    brightGreen: "#a9f0b0",
    brightYellow: "#ffdf7a",
    brightBlue: "#b5c6ff",
    brightMagenta: "#e8c4ff",
    brightCyan: "#a8f0e6",
    brightWhite: "#fff7ea",
  },
};
