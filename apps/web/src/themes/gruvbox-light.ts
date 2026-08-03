import type { Theme } from "./types";

// Ported from Gruvbox Light (https://github.com/morhetz/gruvbox, MIT/X11;
// ANSI palette via https://github.com/mbadolato/iTerm2-Color-Schemes, MIT).
//
// The cream side of the same retro palette: bg0 → terminal panes, bg1 →
// chrome, bg2 → hover/borders, burnt orange as accent. One departure: the
// upstream scheme's near-black selection would bury un-inverted xterm text,
// so selection uses bg2 like gruvbox terminals typically do.
export const gruvboxLight: Theme = {
  id: "gruvbox-light",
  name: "Gruvbox Light",
  appearance: "light",
  colors: {
    bg: "#fbf1c7",
    bg2: "#ebdbb2",
    bg3: "#d5c4a1",
    border: "#d5c4a1",
    fg: "#3c3836",
    fgDim: "#7c6f64",
    accent: "#d65d0e",
    accentSoft: "rgba(214, 93, 14, 0.12)",
  },
  radius: { sm: "4px", md: "6px", lg: "8px" },
  term: {
    background: "#fbf1c7",
    foreground: "#3c3836",
    cursor: "#3c3836",
    selectionBackground: "#d5c4a1",
    black: "#fbf1c7",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#7c6f64",
    brightBlack: "#928374",
    brightRed: "#9d0006",
    brightGreen: "#79740e",
    brightYellow: "#b57614",
    brightBlue: "#076678",
    brightMagenta: "#8f3f71",
    brightCyan: "#427b58",
    brightWhite: "#3c3836",
  },
};
