import type { Theme } from "./types";
// The sidebar scene (tree + snowman) is laid out by this stylesheet, scoped
// to html[data-theme="christmas"]. The art is in ./christmas/.
import "./christmas/christmas.css";

// Christmas. A snowy midnight-blue shell around snow-white text, with
// cranberry red as the accent. The sidebar is K1 (#0c1424) from the scene's
// palette (christmas/art.ts), so the pixel art has no seam.
export const christmas: Theme = {
  id: "christmas",
  name: "Christmas",
  appearance: "dark",
  colors: {
    bg: "#0c1424",
    bg2: "#121c30",
    bg3: "#1d2b45",
    border: "#1d2b45",
    fg: "#eef3fb",
    fgDim: "#9fb0cc",
    accent: "#ff5f6d",
    accentSoft: "rgba(255, 95, 109, 0.18)",
  },
  radius: { sm: "4px", md: "6px", lg: "8px" },
  sidebar: { bg: "#0c1424", border: "#1d2b45" },
  chrome: {
    topBar: "#121c30",
    activeTab: "#0c1424",
    activeRow: "#1d2b45",
  },
  term: {
    background: "#0c1424",
    foreground: "#eef3fb",
    cursor: "#ff5f6d",
    cursorAccent: "#0c1424",
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
