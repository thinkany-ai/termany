import type { Theme } from "./types";
// The pixel art lives in ./scenes/lights-out (the sidebar's jack-o'-lantern) and
// ./effects/lights-out (the garland and the dark); this stylesheet makes room.
import "./lights-out.css";

// Original Termany theme for Halloween, in pixel art. Near-black everywhere,
// so the only light in the window is the text, the jack-o'-lantern and the
// eyes. Amber is the one accent: the cursor, the focus ring, the eyes.
export const lightsOut: Theme = {
  id: "lights-out",
  name: "Lights Out",
  appearance: "dark",
  colors: {
    bg: "#0c0a0e",
    bg2: "#09070b",
    bg3: "#1d1822",
    border: "#221c28",
    fg: "#e9e2d6",
    fgDim: "#8a8090",
    accent: "#ffb21e",
    accentSoft: "rgba(255, 178, 30, 0.16)",
  },
  radius: { sm: "4px", md: "6px", lg: "8px" },
  sidebar: { bg: "#09070b", border: "#17131b" },
  chrome: {
    topBar: "#09070b",
    topBarBorder: "#17131b",
    activeTab: "#0c0a0e",
    activeRow: "#1d1822",
    paneGap: "8px",
    paneBorder: "#221c28",
    paneShadow: "none",
  },
  term: {
    background: "#0c0a0e",
    foreground: "#e9e2d6",
    cursor: "#ffb21e",
    cursorAccent: "#0c0a0e",
    selectionBackground: "#3a2c18",
    black: "#221c28",
    red: "#ff4d4d",
    green: "#8bd450",
    yellow: "#ffb21e",
    blue: "#7d8cff",
    magenta: "#c77dff",
    cyan: "#5ee6c8",
    white: "#d9d0c2",
    brightBlack: "#5e5468",
    brightRed: "#ff7a7a",
    brightGreen: "#b4f07a",
    brightYellow: "#ffd27a",
    brightBlue: "#a6b0ff",
    brightMagenta: "#dcaaff",
    brightCyan: "#93f5df",
    brightWhite: "#fff7ea",
  },
};
