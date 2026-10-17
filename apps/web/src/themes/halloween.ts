import type { Theme } from "./types";
// The ghost that floats while an agent works and the pumpkin it leaves when
// done can't be expressed with the flat color tokens, so they live in a
// stylesheet scoped to html[data-theme="halloween"] — see applyThemeObject()
// in ./index.ts. The sidebar's graveyard is a drawn scene: ./scenes/halloween.tsx.
import "./halloween.css";

// Original Termany theme for Halloween. A night sky in near-black violet,
// parchment text, and pumpkin orange as the one warm accent: the cursor, the
// focus ring and the selected tab all glow like a candle in a jack-o'-lantern.
// ANSI keeps its meaning but every hue is costume-coded: blood red, slime
// green, candle yellow, witch purple, ghost cyan.
export const halloween: Theme = {
  id: "halloween",
  name: "Halloween",
  appearance: "dark",
  colors: {
    bg: "#120d18",
    bg2: "#1a1222",
    bg3: "#2a1d36",
    border: "#3a2748",
    fg: "#f3e9dc",
    fgDim: "#a08fae",
    accent: "#ff7518",
    accentSoft: "rgba(255, 117, 24, 0.18)",
  },
  radius: { sm: "4px", md: "6px", lg: "8px" },
  sidebar: { bg: "#150f1c", border: "#3a2748" },
  chrome: {
    topBar: "linear-gradient(180deg, #21162d 0%, #1a1222 100%)",
    topBarBorder: "#3a2748",
    activeTab: "#120d18",
    activeRow: "#2f1f3d",
    paneGap: "6px",
    paneBorder: "#3a2748",
    paneShadow: "0 1px 3px rgba(0, 0, 0, 0.5)",
  },
  term: {
    background: "#120d18",
    foreground: "#f3e9dc",
    cursor: "#ff7518",
    cursorAccent: "#120d18",
    selectionBackground: "#4a2c5e",
    black: "#2a1d36",
    red: "#ff4d5e",
    green: "#8bd450",
    yellow: "#ffb347",
    blue: "#7d8cff",
    magenta: "#c77dff",
    cyan: "#5ee6c8",
    white: "#e6d9c6",
    brightBlack: "#6b5580",
    brightRed: "#ff7a85",
    brightGreen: "#b4f07a",
    brightYellow: "#ffd38a",
    brightBlue: "#a6b0ff",
    brightMagenta: "#dcaaff",
    brightCyan: "#93f5df",
    brightWhite: "#fff7ea",
  },
};
