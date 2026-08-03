import type { Theme } from "./types";

// Ported from Rosé Pine Dawn (https://github.com/rose-pine/palette and
// https://github.com/rose-pine/alacritty), MIT License.
//
// Dawn inverts the depth: surface is a near-white that floats ABOVE the
// warm paper base, so the chrome is lighter than the terminal — same move
// as codex. Roles otherwise mirror rose-pine: overlay → hover,
// highlight-med → borders, rose → accent.
export const rosePineDawn: Theme = {
  id: "rose-pine-dawn",
  name: "Rosé Pine Dawn",
  appearance: "light",
  colors: {
    bg: "#faf4ed",
    bg2: "#fffaf3",
    bg3: "#f2e9e1",
    border: "#dfdad9",
    fg: "#575279",
    fgDim: "#797593",
    accent: "#d7827e",
    accentSoft: "rgba(215, 130, 126, 0.12)",
  },
  radius: { sm: "8px", md: "10px", lg: "14px" },
  term: {
    background: "#faf4ed",
    foreground: "#575279",
    cursor: "#cecacd",
    selectionBackground: "#dfdad9",
    black: "#f2e9e1",
    red: "#b4637a",
    green: "#286983",
    yellow: "#ea9d34",
    blue: "#56949f",
    magenta: "#907aa9",
    cyan: "#d7827e",
    white: "#575279",
    brightBlack: "#9893a5",
    brightRed: "#b4637a",
    brightGreen: "#286983",
    brightYellow: "#ea9d34",
    brightBlue: "#56949f",
    brightMagenta: "#907aa9",
    brightCyan: "#d7827e",
    brightWhite: "#575279",
  },
};
