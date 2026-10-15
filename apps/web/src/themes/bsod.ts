import type { Theme } from "./types";
import "./bsod.css";

// A deliberately monochrome shell: the blue is constant across all surfaces.
// Near-white ANSI tints preserve the meaning of color without disappearing
// into BSOD blue. Borders, underlines and focus outlines provide hierarchy.
export const bsod: Theme = {
  id: "bsod",
  name: "Blue Screen",
  appearance: "dark",
  colors: {
    bg: "#0078d7",
    bg2: "#0078d7",
    bg3: "#0078d7",
    border: "#85bde9",
    fg: "#ffffff",
    fgDim: "#edf6ff",
    accent: "#ffffff",
    accentSoft: "rgba(255, 255, 255, 0.15)",
  },
  radius: {
    sm: "0px",
    md: "0px",
    lg: "0px",
  },
  sidebar: {
    bg: "#0078d7",
    border: "#85bde9",
  },
  chrome: {
    topBar: "#0078d7",
    topBarBorder: "#85bde9",
    activeTab: "#0078d7",
    activeRow: "#0078d7",
    paneGap: "0px",
    paneRadius: "0px",
    paneBorder: "transparent",
    paneShadow: "none",
  },
  term: {
    background: "#0078d7",
    foreground: "#ffffff",
    cursor: "#ffffff",
    cursorAccent: "#0078d7",
    selectionBackground: "#00579c",
    black: "#edf6ff",
    red: "#ffe1de",
    green: "#dcffdb",
    yellow: "#fff4ba",
    blue: "#dcecff",
    magenta: "#fbe0ff",
    cyan: "#d6ffff",
    white: "#f2f7ff",
    brightBlack: "#d7eaff",
    brightRed: "#ffe9e7",
    brightGreen: "#eaffea",
    brightYellow: "#fff9dc",
    brightBlue: "#edf5ff",
    brightMagenta: "#fff0ff",
    brightCyan: "#edffff",
    brightWhite: "#ffffff",
  },
  vars: {
    "--pane-focus-ring": "#ffffff",
    "--split-gutter-hover": "#ffffff",
  },
};
