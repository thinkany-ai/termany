import type { Theme } from "./types";
import "./getaway.css";
// Original artwork, generated for this theme: a beachfront at magic hour with
// a neon deco hotel and an unbadged sports car of no real make in the lower
// left (where the sidebar shows them), a lifeguard tower, a speedboat, a
// helicopter and a skyline. It has no people, text or logos and is not
// derived from any game, film or brand asset.
import coast from "./getaway/coast.jpg";

// Getaway. A couple on the run along a subtropical coast at magic hour. The
// painted coast fills the window; the sidebar, the tab bar and the gaps
// between panes let it through, and every pane floats on it as a dark card.
// The theme uses no third-party names, logos, characters, typefaces or artwork.
export const getaway: Theme = {
  id: "getaway",
  name: "Getaway",
  appearance: "dark",
  colors: {
    bg: "#171328",
    bg2: "#1d1733",
    bg3: "#2e2550",
    border: "#3a2e5e",
    fg: "#fdfbff",
    fgDim: "#bcb3d9",
    accent: "#ffb2c6",
    accentSoft: "rgba(255, 178, 198, 0.16)",
  },
  radius: { sm: "6px", md: "8px", lg: "12px" },
  sidebar: { bg: "#1b1531", border: "transparent" },
  chrome: {
    // The sky shows through the tab bar under a light scrim.
    topBar: "linear-gradient(rgba(27, 21, 49, 0.45), rgba(27, 21, 49, 0.25))",
    topBarBorder: "transparent",
    activeTab: "#171328",
    activeRow: "rgba(255, 178, 198, 0.18)",
    paneGap: "8px",
    paneRadius: "10px",
    paneBorder: "rgba(255, 255, 255, 0.14)",
    paneShadow: "0 2px 6px rgba(10, 6, 25, 0.35)",
  },
  background: { image: coast, opacity: 0.72 },
  term: {
    // Transparent: each terminal pane paints a near-opaque night scrim over
    // the coast (getaway.css), dark enough for every ANSI color.
    background: "#17132800",
    foreground: "#f4f1ff",
    cursor: "#ffb2c6",
    cursorAccent: "#171328",
    selectionBackground: "#43386e",
    black: "#3a3462",
    red: "#ff7b8c",
    green: "#7fe0a6",
    yellow: "#ffd27f",
    blue: "#7fb0ff",
    magenta: "#ef8fd6",
    cyan: "#6fdcdc",
    white: "#dad4ef",
    // Lifted above the usual dim gray: the scrim lets some of the bright
    // coast through, and hint text must stay above 4:1 over it.
    brightBlack: "#a9a3cf",
    brightRed: "#ffa0ab",
    brightGreen: "#a8f0c4",
    brightYellow: "#ffe5aa",
    brightBlue: "#a9caff",
    brightMagenta: "#f7b6e6",
    brightCyan: "#9cecec",
    brightWhite: "#ffffff",
  },
  vars: {
    "--accent-fg": "#171328",
    "--pane-area-bg": "transparent",
    // The Bots conversation stays opaque so long messages read cleanly.
    "--agent-surface-bg": "#171328",
    "--split-gutter-hover": "#ffb2c6",
  },
};
