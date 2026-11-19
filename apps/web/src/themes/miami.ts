import type { Theme } from "./types";
import "./miami.css";
// Original artwork, generated for this theme: a beachfront at magic hour with
// a neon deco hotel and an unbadged sports car of no real make in the lower
// left (where the sidebar shows them), a lifeguard tower, a speedboat, a
// helicopter and a skyline. It has no people, text or logos and is not
// derived from any game, film or brand asset.
import coast from "./miami/coast.jpg";

// Miami. A subtropical beach city at magic hour, after Miami Beach. The
// painted coast fills the window; the sidebar, the tab bar and the gaps
// between panes let it through, and every pane floats on it as frosted glass.
// The theme uses no third-party names, logos, characters, typefaces or artwork.

// A palm icon for the chrome: section headings, the active tab and the
// workspace name use it as a CSS mask, so each spot sets its own color.
const PALM_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#000">
  <path d="M13.1 9.6c.9 3.9.7 8.1-.7 12.4h-2.3c1.4-4.1 1.6-8.2.9-12z"/>
  <path d="M12.2 9.2C10 5.2 5.6 4.3 1.8 6.6c3.4-.1 6.4.9 8.9 3.6z"/>
  <path d="M11.8 9.4C8.4 8.3 4.4 9.8 2.2 13.6c2.9-2 6.3-2.7 9.6-2.4z"/>
  <path d="M12.2 9.2c-1.9-2.8-2-6.2-.1-9 .1 3 .9 5.8 2 8.4z"/>
  <path d="M12.2 9.2c.5-4 3.3-6.9 7.4-7.6-2.7 1.9-4.6 4.4-5.6 8z"/>
  <path d="M12.4 9.4c3.6-1.9 7.9-1.2 10.8 2.2-3.4-1-6.8-.9-9.9.7z"/>
  <path d="M12.6 9.6c3.2.2 6 2.5 6.8 6.3-1.8-2.6-4.1-4.2-7-4.8z"/>
</svg>`;
const svgUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

export const miami: Theme = {
  id: "miami",
  name: "Miami",
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
  sidebar: { bg: "#1b1531", border: "rgba(255, 255, 255, 0.08)" },
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
    // Transparent: each terminal pane is frosted glass over the coast
    // (miami.css). The RGB part still matters: xterm's WebGL renderer
    // composites dim text onto this color made opaque, so it is set to the
    // glass's average tint to keep those cells from showing as dark blocks.
    background: "#351c3000",
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
    "--miami-palm": svgUrl(PALM_ICON),
    "--accent-fg": "#171328",
    "--pane-area-bg": "transparent",
    // The Bots conversation stays opaque so long messages read cleanly.
    "--agent-surface-bg": "#171328",
    "--split-gutter-hover": "#ffb2c6",
  },
};
