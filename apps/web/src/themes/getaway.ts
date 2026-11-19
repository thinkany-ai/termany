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

// Palm silhouettes in the chrome, drawn over the painting for foreground depth.
// One frond is a crescent from the crown (0,0); rotated copies make a crown.
// SVG rotates clockwise: 0deg points left, 90 up, 180 right. The set leans low
// on both sides so the crown droops.
const PALM_INK = "#170d27";
const FROND = "M0 0q-16-14-36-6q22 0 36 6z";
const crown = (fill: string) =>
  `<g fill="${fill}">${[-45, -15, 20, 70, 110, 160, 195, 225]
    .map((deg, i) => `<path d="${FROND}" transform="rotate(${deg}) scale(${i % 2 ? 0.85 : 1})"/>`)
    .join("")}</g>`;
const svgUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

// Crowns hanging into the tab bar, a 900x36 tile repeated along its width.
const TAB_BAR_FRONDS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 36">
  <g opacity=".6">
    <g transform="translate(120 -4) scale(1.1)">${crown(PALM_INK)}</g>
    <g transform="translate(430 -10) scale(.8)">${crown(PALM_INK)}</g>
    <g transform="translate(700 -2) scale(1.2)">${crown(PALM_INK)}</g>
  </g>
</svg>`;

// Two palms leaning in from the sidebar's right edge, 240x480, bottom-right.
const SIDEBAR_PALMS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 480">
  <g fill="none" stroke="${PALM_INK}" stroke-linecap="round">
    <path d="M230 482Q238 300 160 110" stroke-width="10"/>
    <path d="M252 482q-6-120-50-220" stroke-width="7"/>
  </g>
  <g transform="translate(160 110) scale(2.1)">${crown(PALM_INK)}</g>
  <g transform="translate(202 262) scale(1.5)">${crown(PALM_INK)}</g>
</svg>`;

// One small palm at the foot of the right rail, 40x140.
const RAIL_PALM = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 140">
  <path d="M22 142q4-60-6-104" stroke="${PALM_INK}" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  <g transform="translate(16 38) scale(.55)">${crown(PALM_INK)}</g>
</svg>`;

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
    // The sky shows through the tab bar under a light scrim, with palm crowns.
    topBar: `${svgUrl(TAB_BAR_FRONDS)} left top / auto 100% repeat-x, linear-gradient(rgba(27, 21, 49, 0.45), rgba(27, 21, 49, 0.25))`,
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
    "--getaway-sidebar-palms": svgUrl(SIDEBAR_PALMS),
    "--getaway-rail-palm": svgUrl(RAIL_PALM),
    "--accent-fg": "#171328",
    "--pane-area-bg": "transparent",
    // The Bots conversation stays opaque so long messages read cleanly.
    "--agent-surface-bg": "#171328",
    "--split-gutter-hover": "#ffb2c6",
  },
};
