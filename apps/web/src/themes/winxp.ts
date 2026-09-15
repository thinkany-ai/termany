import type { Theme } from "./types";
import "./winxp.css";

// Luna Blue: cream controls, glossy blue captions and a black command prompt.
// Window/command-button states live in the scoped stylesheet, as in win98.
export const winxp: Theme = {
  id: "winxp",
  name: "Windows XP",
  appearance: "light",
  colors: {
    bg: "#ffffff",
    bg2: "#ece9d8",
    bg3: "#f5f3e8",
    border: "#aca899",
    fg: "#222222",
    fgDim: "#57564e",
    accent: "#245edb",
    accentSoft: "rgba(49, 106, 197, 0.16)",
  },
  radius: { sm: "3px", md: "3px", lg: "7px" },
  sidebar: { bg: "#7b9fe5", border: "#4b73bb" },
  chrome: {
    topBar: "linear-gradient(#3168d5, #4993f7 8%, #245edb 22%, #245edb 85%, #1941a5)",
    topBarBorder: "#1941a5",
    activeTab: "#1645a5",
    activeRow: "#316ac5",
    paneGap: "5px",
    paneRadius: "7px 7px 0 0",
    paneBorder: "#0054e3",
    paneShadow: "0 1px 2px rgba(0, 0, 0, 0.18)",
  },
  term: {
    background: "#000000",
    foreground: "#d8d8d8",
    cursor: "#d8d8d8",
    selectionBackground: "#2456a6",
    selectionForeground: "#ffffff",
    // Lift the old console's dark ANSI colors so agent output remains readable.
    black: "#000000",
    red: "#cc5555",
    green: "#55aa55",
    yellow: "#b5a642",
    blue: "#5c85df",
    magenta: "#bb66bb",
    cyan: "#45aaaa",
    white: "#c0c0c0",
    brightBlack: "#808080",
    brightRed: "#ff7777",
    brightGreen: "#77dd77",
    brightYellow: "#eeee77",
    brightBlue: "#88aaff",
    brightMagenta: "#ee99ee",
    brightCyan: "#77dddd",
    brightWhite: "#ffffff",
  },
  vars: {
    "--pane-area-bg": "#7f9db9",
    "--pane-focus-ring": "transparent",
    "--split-gutter-hover": "#0054e3",
  },
};
