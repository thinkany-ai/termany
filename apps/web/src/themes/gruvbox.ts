import type { Theme } from "./types";

// Ported from Gruvbox (https://github.com/morhetz/gruvbox, MIT/X11; ANSI
// palette via https://github.com/mbadolato/iTerm2-Color-Schemes, MIT).
//
// Warm retro browns off the medium-contrast palette: bg0 → terminal panes,
// bg0_soft → chrome, bg0_hard → a recessed sidebar rail, and the signature
// bright orange as accent. Small radii on purpose — boxy suits gruvbox.
export const gruvbox: Theme = {
  id: "gruvbox",
  name: "Gruvbox Dark",
  appearance: "dark",
  colors: {
    bg: "#282828",
    bg2: "#32302f",
    bg3: "#504945",
    border: "#504945",
    fg: "#ebdbb2",
    fgDim: "#928374",
    accent: "#fe8019",
    accentSoft: "rgba(254, 128, 25, 0.15)",
  },
  radius: { sm: "4px", md: "6px", lg: "8px" },
  sidebar: { bg: "#1d2021" },
  term: {
    background: "#282828",
    foreground: "#ebdbb2",
    cursor: "#ebdbb2",
    selectionBackground: "#665c54",
    black: "#282828",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#a89984",
    brightBlack: "#928374",
    brightRed: "#fb4934",
    brightGreen: "#b8bb26",
    brightYellow: "#fabd2f",
    brightBlue: "#83a598",
    brightMagenta: "#d3869b",
    brightCyan: "#8ec07c",
    brightWhite: "#ebdbb2",
  },
};
