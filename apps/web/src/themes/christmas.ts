import type { Theme } from "./types";
// The window-wide artwork, frosted surfaces, pane snow and lights are styled
// here, scoped to html[data-theme="christmas"]. The art is in ./christmas/.
import "./christmas/christmas.css";

// Christmas. The whole window is a snowy night (christmas/backdrop.tsx): the
// sidebar and top bar are translucent so the artwork shows through, and the
// terminals stay opaque midnight-blue cards with snow-white text and a
// cranberry accent.
export const christmas: Theme = {
  id: "christmas",
  name: "Christmas",
  appearance: "dark",
  colors: {
    bg: "#0b0f22",
    bg2: "#121833",
    bg3: "#1d2547",
    border: "#26305a",
    fg: "#eef3fb",
    fgDim: "#9fb0cc",
    accent: "#ff5f6d",
    accentSoft: "rgba(255, 95, 109, 0.18)",
  },
  radius: { sm: "4px", md: "6px", lg: "8px" },
  sidebar: { bg: "rgba(10, 14, 32, 0.35)", border: "rgba(140, 160, 230, 0.16)" },
  chrome: {
    topBar: "rgba(10, 14, 32, 0.5)",
    topBarBorder: "rgba(140, 160, 230, 0.14)",
    activeTab: "rgba(11, 15, 34, 0.9)",
    activeRow: "rgba(120, 140, 220, 0.2)",
    paneGap: "8px",
    paneBorder: "rgba(150, 170, 235, 0.22)",
    paneShadow: "0 8px 24px rgba(0, 0, 0, 0.45)",
  },
  // The pane gutters show the artwork.
  vars: { "pane-area-bg": "transparent" },
  term: {
    background: "#0b0f22",
    foreground: "#eef3fb",
    cursor: "#ff5f6d",
    cursorAccent: "#0b0f22",
    selectionBackground: "#2c4470",
    black: "#1d2b45",
    red: "#ff6b74",
    green: "#6fdc8c",
    yellow: "#ffd166",
    blue: "#7cb8ff",
    magenta: "#d7a4ff",
    cyan: "#6fdfe0",
    white: "#dbe5f3",
    brightBlack: "#8a9cbd",
    brightRed: "#ff9aa0",
    brightGreen: "#a6f0b8",
    brightYellow: "#ffe39a",
    brightBlue: "#b0d4ff",
    brightMagenta: "#ead0ff",
    brightCyan: "#a8f2f0",
    brightWhite: "#ffffff",
  },
};
