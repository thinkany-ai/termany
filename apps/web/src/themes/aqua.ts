import type { Theme } from "./types";
import "./aqua.css";

// Panther/Tiger-era metal, pinstripes, and gel controls. The white Terminal.app
// client area uses a dark ANSI palette, including the nominal bright slots, so
// colored output is readable on white. Terminal font preferences stay intact.
export const aqua: Theme = {
  id: "aqua",
  name: "Aqua",
  appearance: "light",
  colors: {
    bg: "#ffffff",
    bg2: "#e5e8eb",
    bg3: "#d4e5f8",
    border: "#9ba4ae",
    fg: "#161b22",
    fgDim: "#4e5965",
    accent: "#075cca",
    accentSoft: "rgba(30, 125, 239, 0.18)",
  },
  radius: {
    sm: "5px",
    md: "12px",
    lg: "10px",
  },
  sidebar: {
    bg: "#e6edf3",
    border: "#929da7",
  },
  chrome: {
    topBar: "linear-gradient(#f7f8f9, #c3c8ce 50%, #e4e7ea)",
    topBarBorder: "#929da7",
    activeTab: "#358eeb",
    activeRow: "#287dda",
    paneGap: "7px",
    paneRadius: "13px",
    paneBorder: "#9ba8b6",
    paneShadow: "0 1px 3px #9ba8b6",
  },
  term: {
    background: "#ffffff",
    foreground: "#111111",
    cursor: "#111111",
    cursorAccent: "#ffffff",
    selectionBackground: "#b8d8ff",
    black: "#242424",
    red: "#ac2525",
    green: "#18722a",
    yellow: "#806000",
    blue: "#154ecc",
    magenta: "#842ba3",
    cyan: "#006879",
    white: "#555555",
    brightBlack: "#666666",
    brightRed: "#bf2020",
    brightGreen: "#187521",
    brightYellow: "#896000",
    brightBlue: "#1859cf",
    brightMagenta: "#9637a6",
    brightCyan: "#006f82",
    brightWhite: "#777777",
  },
  vars: {
    "--pane-focus-ring": "#459df5",
    "--split-gutter-hover": "#398deb",
  },
};
