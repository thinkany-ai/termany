import type { Theme } from "./types";
// The 3D chrome (bevelled buttons, title bars, sunken inputs) can't be expressed
// with the flat color tokens, so it lives in a stylesheet scoped to
// html[data-theme="win98"] — see applyThemeObject() in ./index.ts.
import "./win98.css";

// Windows 98. Gray #c0c0c0 button face, navy title bars, square corners, and a
// black VGA console inside each pane. `bg` is white (the "client area" of a
// classic window — the file tree and agent panes sit on it); the terminal draws
// its own black background, and win98.css paints the terminal's frame to match.
export const win98: Theme = {
  id: "win98",
  name: "Windows 98",
  appearance: "light",
  colors: {
    bg: "#ffffff",
    bg2: "#c0c0c0",
    bg3: "#dfdfdf",
    border: "#808080",
    fg: "#000000",
    fgDim: "#404040",
    accent: "#000080",
    accentSoft: "rgba(0, 0, 128, 0.16)",
  },
  // Every corner in Windows 98 is square.
  radius: { sm: "0px", md: "0px", lg: "0px" },
  sidebar: { bg: "#c0c0c0", border: "#808080" },
  chrome: {
    topBar: "#c0c0c0",
    topBarBorder: "#808080",
    activeTab: "#c0c0c0",
    activeRow: "#000080",
    // A small gap so each pane reads as an MDI child window floating on the
    // application workspace (--pane-area-bg below).
    paneGap: "3px",
    paneRadius: "0px",
    // win98.css draws the pane's raised 3D edge as a two-tone border instead.
    paneBorder: "transparent",
    paneShadow: "none",
  },
  term: {
    // The MS-DOS Prompt palette: black screen, light-gray text, CGA 16.
    background: "#000000",
    foreground: "#c0c0c0",
    cursor: "#c0c0c0",
    selectionBackground: "#000080",
    black: "#000000",
    red: "#800000",
    green: "#008000",
    yellow: "#808000",
    blue: "#000080",
    magenta: "#800080",
    cyan: "#008080",
    white: "#c0c0c0",
    brightBlack: "#808080",
    brightRed: "#ff0000",
    brightGreen: "#00ff00",
    brightYellow: "#ffff00",
    brightBlue: "#0000ff",
    brightMagenta: "#ff00ff",
    brightCyan: "#00ffff",
    brightWhite: "#ffffff",
  },
  vars: {
    // Panes float on the mid-gray application workspace, like MDI children.
    "--pane-area-bg": "#808080",
    // The focused pane already announces itself with a navy title bar, the way
    // a Windows 98 active window does — an accent ring on top would be noise.
    "--pane-focus-ring": "transparent",
    "--split-gutter-hover": "#000080",
  },
};
