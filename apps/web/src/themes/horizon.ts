import type { Theme } from "./types";

// Original Termany theme. Sunset warmth in flat blocks: cream cards floating
// over solid peach chrome with a deeper peach sidebar, coral accent. No
// gradients — the warm color blocking carries it.
export const horizon: Theme = {
  id: "horizon",
  name: "Horizon",
  appearance: "light",
  colors: {
    bg: "#fffaf4",
    bg2: "#ffe9d9",
    bg3: "#ffd9c2",
    border: "#f0cfb8",
    fg: "#46425e",
    fgDim: "#8d8699",
    accent: "#f96f5d",
    accentSoft: "rgba(249, 111, 93, 0.14)",
  },
  radius: { sm: "10px", md: "12px", lg: "16px" },
  sidebar: { bg: "#ffdfc9" },
  chrome: {
    paneGap: "10px",
    paneRadius: "16px",
    paneBorder: "rgba(70, 64, 92, 0.12)",
    paneShadow: "0 6px 18px rgba(150, 90, 70, 0.2)",
  },
  term: {
    background: "#fffaf4",
    foreground: "#46425e",
    cursor: "#f96f5d",
    selectionBackground: "rgba(249, 111, 93, 0.22)",
    black: "#ece4da",
    red: "#d6455d",
    green: "#2f9e6e",
    yellow: "#c07f00",
    blue: "#3a74d9",
    magenta: "#a75ac8",
    cyan: "#0f9ba8",
    white: "#6f6a85",
    brightBlack: "#a49d92",
    brightRed: "#e4576f",
    brightGreen: "#37b980",
    brightYellow: "#d9950a",
    brightBlue: "#5b8ce4",
    brightMagenta: "#bc74da",
    brightCyan: "#16b4c2",
    brightWhite: "#46425e",
  },
};
