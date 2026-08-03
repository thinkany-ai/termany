import type { Theme } from "./types";

// Original Termany theme. A green-phosphor CRT: near-black glass, everything
// in the green ramp, hard corners, flush edge-to-edge panes — the anti-card.
// ANSI keeps usable semantic hues (red errors, chartreuse yellow, violet
// magenta) but pulls every one toward the phosphor glow.
export const phosphor: Theme = {
  id: "phosphor",
  name: "Phosphor",
  appearance: "dark",
  colors: {
    bg: "#010402",
    bg2: "#04120a",
    bg3: "#0a2416",
    border: "#0f3520",
    fg: "#3dff8c",
    fgDim: "#1e9e5a",
    accent: "#3dff8c",
    accentSoft: "rgba(61, 255, 140, 0.18)",
  },
  radius: { sm: "2px", md: "3px", lg: "4px" },
  chrome: {
    paneGap: "0px",
    paneRadius: "0px",
    paneBorder: "transparent",
    paneShadow: "none",
  },
  term: {
    background: "#010402",
    foreground: "#3dff8c",
    cursor: "#3dff8c",
    selectionBackground: "#0f3520",
    black: "#0a2416",
    red: "#ff6d5a",
    green: "#3dff8c",
    yellow: "#d8ff5e",
    blue: "#4aa8ff",
    magenta: "#b591ff",
    cyan: "#35e0c8",
    white: "#b8ffd6",
    brightBlack: "#14663c",
    brightRed: "#ff8a75",
    brightGreen: "#7dffb4",
    brightYellow: "#eaff9c",
    brightBlue: "#7cc0ff",
    brightMagenta: "#cbb0ff",
    brightCyan: "#78f0dd",
    brightWhite: "#eafff2",
  },
};
