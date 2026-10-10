import type { Theme } from "./types";
import "./winxp.css";

// Luna keeps cream controls and white document/chat surfaces separate from the
// black cmd.exe console. ANSI dark slots are lifted for modern agent output;
// the recognizable XP colors belong to the chrome, not low-contrast text.
export const winxp: Theme = {
  id: "winxp",
  name: "Windows XP",
  appearance: "light",
  colors: {
    bg: "#ffffff",
    bg2: "#ece9d8",
    bg3: "#d9e8fc",
    border: "#7f9db9",
    fg: "#172b4d",
    fgDim: "#425875",
    accent: "#287b16",
    accentSoft: "rgba(72, 153, 38, 0.18)",
  },
  radius: {
    sm: "3px",
    md: "5px",
    lg: "8px",
  },
  sidebar: {
    bg: "#729ee2",
    border: "#245dcc",
  },
  chrome: {
    topBar: "linear-gradient(#69a6ff 0%, #0965ec 12%, #0054dc 55%, #2080f5 94%, #003cb4)",
    topBarBorder: "#003caa",
    activeTab: "#2365c9",
    activeRow: "#c1d6fa",
    paneGap: "9px",
    paneRadius: "10px",
    paneBorder: "#0054df",
    paneShadow: "0 1px 3px #174c9e",
  },
  // Original vector landscape, not the Windows wallpaper photograph. Only
  // the pane gaps reveal it; terminal and chat content remain opaque.
  background: {
    image: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000">
  <defs>
    <linearGradient id="sky" x2="0" y2="1"><stop stop-color="#287bdf"/><stop offset="1" stop-color="#a7d9ff"/></linearGradient>
    <linearGradient id="hill" x2="0" y2="1"><stop stop-color="#83c735"/><stop offset="1" stop-color="#347816"/></linearGradient>
  </defs>
  <path fill="url(#sky)" d="M0 0h1600v1000H0z"/>
  <g fill="#fff" opacity=".6">
    <ellipse cx="330" cy="210" rx="150" ry="28"/>
    <ellipse cx="440" cy="190" rx="95" ry="40"/>
    <ellipse cx="1190" cy="320" rx="180" ry="32"/>
  </g>
  <path fill="#4f9824" d="M0 770Q400 490 950 760T1600 680V1000H0z"/>
  <path fill="url(#hill)" d="M0 730Q400 880 1000 670T1600 720V1000H0z"/>
</svg>`)}`,
    opacity: 0,
  },
  term: {
    background: "#080808",
    foreground: "#d8d8d8",
    cursor: "#ffffff",
    cursorAccent: "#080808",
    selectionBackground: "#294d81",
    black: "#707070",
    red: "#ee7777",
    green: "#68c765",
    yellow: "#d4c365",
    blue: "#79a6ff",
    magenta: "#ce8fdf",
    cyan: "#66c7d1",
    white: "#d8d8d8",
    brightBlack: "#9e9e9e",
    brightRed: "#ff9999",
    brightGreen: "#91e889",
    brightYellow: "#fff29b",
    brightBlue: "#a6c6ff",
    brightMagenta: "#efb0ff",
    brightCyan: "#96edf2",
    brightWhite: "#ffffff",
  },
  vars: {
    "--pane-area-bg": "transparent",
    "--agent-surface-bg": "#ffffff",
    "--sidebar-bg": "#729ee2",
    "--top-bar": "linear-gradient(#69a6ff 0%, #0965ec 12%, #0054dc 55%, #2080f5 94%, #003cb4)",
    "--pane-focus-ring": "#67b637",
    "--split-gutter-hover": "#9de462",
  },
};
