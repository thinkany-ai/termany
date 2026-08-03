import type { Theme } from "./types";

// Ported from Rosé Pine (https://github.com/rose-pine/palette and
// https://github.com/rose-pine/alacritty), MIT License.
//
// The official role mapping: base → terminal panes, surface → chrome,
// overlay → hover, highlight-med → borders (per the palette spec), subtle →
// muted text, rose → accent. Generous radii — soho vibes, not a toolbox.
export const rosePine: Theme = {
  id: "rose-pine",
  name: "Rosé Pine",
  appearance: "dark",
  colors: {
    bg: "#191724",
    bg2: "#1f1d2e",
    bg3: "#26233a",
    border: "#403d52",
    fg: "#e0def4",
    fgDim: "#908caa",
    accent: "#ebbcba",
    accentSoft: "rgba(235, 188, 186, 0.14)",
  },
  radius: { sm: "8px", md: "10px", lg: "14px" },
  term: {
    background: "#191724",
    foreground: "#e0def4",
    cursor: "#524f67",
    selectionBackground: "#403d52",
    black: "#26233a",
    red: "#eb6f92",
    green: "#31748f",
    yellow: "#f6c177",
    blue: "#9ccfd8",
    magenta: "#c4a7e7",
    cyan: "#ebbcba",
    white: "#e0def4",
    brightBlack: "#6e6a86",
    brightRed: "#eb6f92",
    brightGreen: "#31748f",
    brightYellow: "#f6c177",
    brightBlue: "#9ccfd8",
    brightMagenta: "#c4a7e7",
    brightCyan: "#ebbcba",
    brightWhite: "#e0def4",
  },
};
