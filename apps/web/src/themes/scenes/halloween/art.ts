// The drawn parts of the Halloween scene, as SVG. Each function returns one
// texture's artwork; the renderer rasterizes them at the canvas resolution
// and the shader composites them with the sky, fog and light (./shader.ts).
//
// Units are scene units: the scene is W×H, and at the sidebar's default width
// one unit is one CSS pixel. Silhouettes are dark and carry their own rim
// light (the moon is behind and above them); everything that glows lives in a
// separate emissive texture so the shader can bloom and flicker it.

import { groundAt, seeded, type Hill } from "./kit";

export const W = 240;
export const H = 260;

export const MOON = { x: 150, y: 84, r: 46 };
/** Where the jack-o'-lantern's candle sits: the source of the warm light. */
export const LAMP = { x: 186, y: 226 };

/** A sprite's place in the scene: top-left corner and size, in units. */
export type Rect = { x: number; y: number; w: number; h: number };

export const PUMPKIN_RECT: Rect = { x: 136, y: 188, w: 100, h: 84 };
export const OWL_HEAD_RECT: Rect = { x: 59, y: 76, w: 22, h: 20 };
/** The owl's neck: the head turns about this point. */
export const OWL_PIVOT = { x: 70, y: 94 };
export const GHOST_SIZE = { w: 40, h: 48 };
export const BAT_SIZE = { w: 26, h: 14 };
export const WITCH_SIZE = { w: 48, h: 34 };

/** Moonlight along an edge, at strength `o`. */
const rim = (o = 0.32) => `stroke="#c9b6f0" stroke-opacity="${o}" stroke-width=".45" fill="none" stroke-linecap="round" stroke-linejoin="round"`;

/** Wrap artwork drawn in a `vw`×`vh` unit box into an SVG of `pw`×`ph` px. */
export function svg(vw: number, vh: number, pw: number, ph: number, body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${vw} ${vh}">${body}</svg>`;
}

const path = (d: string, attrs: string) => `<path d="${d}" ${attrs}/>`;

// ---------------------------------------------------------------------------
// Far: the ridge with its pines, the house hill, and the house.

const RIDGE: Hill = {
  start: [0, 168],
  curves: [
    [30, 160, 60, 158, 90, 163],
    [120, 168, 150, 166, 180, 160],
    [205, 155, 225, 156, 240, 160],
  ],
};
const HOUSE_HILL: Hill = {
  start: [0, 196],
  curves: [
    [30, 188, 60, 182, 92, 178],
    [130, 172, 180, 172, 240, 180],
  ],
};

const crest = (h: Hill) => `M${h.start.join(" ")}${h.curves.map((c) => `C${c.join(" ")}`).join("")}`;
const hill = (h: Hill) => `${crest(h)}V${H}H0Z`;

function pine(x: number, y: number, h: number) {
  let d = "";
  for (let i = 0; i < 4; i++) {
    const top = y - h * (0.2 + (0.8 * (i + 1)) / 4);
    const bottom = y - h * (0.12 + (0.8 * i) / 4);
    const half = (h * 0.34 * (4 - i)) / 4;
    d += `M${(x - half).toFixed(2)} ${bottom.toFixed(2)}L${x} ${top.toFixed(2)}L${(x + half).toFixed(2)} ${bottom.toFixed(2)}Z`;
  }
  return `${d}M${x - 0.4} ${y}h.8V${(y - h * 0.22).toFixed(2)}h-.8Z`;
}
const PINES: [number, number][] = [
  [4, 12], [10, 9], [16, 14], [22, 10], [30, 8], [38, 11], [46, 7], [54, 9],
  [196, 9], [203, 13], [209, 8], [216, 11], [223, 14], [230, 9], [237, 12],
];

/** Windows, shared by the dark house and its emissive twin. */
const WINDOWS: { d: string; curtains?: boolean }[] = [
  { d: "M118.5 117V110.5a2.5 2.5 0 0 1 5 0V117Z" }, // tower, arched
  { d: "M135 128h6.4v9.6H135Z", curtains: true },
  { d: "M149 128h6.4v9.6H149Z", curtains: true },
  { d: "M163 128h6.4v9.6H163Z", curtains: true },
  { d: "M143.6 112h4.8v6.4h-4.8Z" }, // dormer
  { d: "M113 166h7.4v8H113Z", curtains: true },
  { d: "M171 166h7.4v8H171Z", curtains: true },
  { d: "M95.4 146h7v9h-7Z", curtains: true },
  { d: "M98.8 131.4a2 2 0 1 0 4 0a2 2 0 1 0-4 0Z" }, // wing gable, round
];

const CRESTING = Array.from({ length: 15 }, (_, i) => {
  const x = 112 + i * 4.8;
  return `M${x - 0.3} 104V101.4L${x} 100.2 ${x + 0.3} 101.4V104Z`;
}).join("");

const BALUSTERS = Array.from({ length: 38 }, (_, i) => 106 + i * 2.1)
  .filter((x) => x < 137 || x > 151)
  .map((x) => `M${x.toFixed(1)} 172.4h.5V180h-.5Z`)
  .join("");

/** The distant ridge and its pines, on their own so the shader can push
 *  them back with haze. */
export function ridgeArt() {
  return `
    <defs>
      <linearGradient id="ridge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22163a"/><stop offset=".3" stop-color="#160e26"/></linearGradient>
    </defs>
    ${path(hill(RIDGE), `fill="url(#ridge)"`)}
    ${path(PINES.map(([x, h]) => pine(x, groundAt(RIDGE, x) + 1.5, h)).join(""), `fill="#130b22"`)}
    ${path(crest(RIDGE), rim(0.12))}`;
}

export function farArt() {
  const house = `
    <defs>
      <linearGradient id="hill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#120a1c"/><stop offset=".25" stop-color="#0a0611"/></linearGradient>
      <linearGradient id="house" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0e0818"/><stop offset="1" stop-color="#07040c"/></linearGradient>
      <pattern id="shingle" width="3" height="2.4" patternUnits="userSpaceOnUse">
        <rect width="3" height="2.4" fill="#0c0716"/>
        <path d="M0 2.4a1.5 1.3 0 0 1 3 0" fill="none" stroke="#1a1130" stroke-width=".35"/>
      </pattern>
    </defs>
    <g fill="url(#house)">
      <rect x="176" y="92" width="6.4" height="16"/>
      <rect x="175" y="90.4" width="8.4" height="2"/>
      <rect x="112" y="98" width="18" height="84"/>
      <path d="M108.5 100.4L112 97.6 121 44 130 97.6 133.5 100.4Z" fill="url(#shingle)"/>
      <rect x="111.4" y="97.6" width="19.2" height="2.4" fill="#1b1128"/>
      <rect x="108" y="122" width="78" height="60"/>
      <path d="M104 124.4L110 104H182L188 124.4Z" fill="url(#shingle)"/>
      <rect x="103.4" y="123.6" width="85.2" height="1.6" fill="#1b1128"/>
      <path d="${CRESTING}" fill="#0e0816"/>
      <path d="M140.5 124V111.6L146 105.6 151.5 111.6V124Z"/>
      <path d="M139 112.2L146 104.2 153 112.2 152.2 112.8 146 105.8 139.8 112.8Z" fill="#1b1128"/>
      <path d="M164.5 124V111.6L170 105.6 175.5 111.6V124Z"/>
      <path d="M163 112.2L170 104.2 177 112.2 176.2 112.8 170 105.8 163.8 112.8Z" fill="#1b1128"/>
      <rect x="90" y="138" width="20" height="44"/>
      <path d="M87 140.4L100 125 113 140.4Z" fill="url(#shingle)"/>
    </g>
    <path d="M121 44V35.6" stroke="#0e0816" stroke-width=".8"/>
    <circle cx="121" cy="39.6" r="1" fill="#0e0816"/>
    <path d="M116 36.6H126M126 36.6l-2-1.3M126 36.6l-2 1.3M116 36.6l-1.2-1.5M116 36.6l-1.2 1.5" stroke="#0e0816" stroke-width=".5" fill="none"/>
    ${WINDOWS.map((w) => path(w.d, `fill="#0a0510"`)).join("")}
    <rect x="167.6" y="112" width="4.8" height="6.4" fill="#06030a"/>
    <rect x="118.5" y="140" width="5" height="9" fill="#06030a"/>
    <path d="M117.8 142.2l6.4 1.6-.2 1-6.4-1.6ZM117.8 146.4l6.4-1.4.2 1-6.4 1.4Z" fill="#3b2618"/>
    <rect x="170.6" y="127.6" width="3" height="10.6" fill="#1d1229" transform="rotate(16 170.6 127.6)"/>
    <path d="M104.5 160.4H187.5L190 165H102Z" fill="#170e23"/>
    <g fill="#120a1b">
      ${[108, 124, 161, 176, 186].map((x) => `<rect x="${x - 0.8}" y="165" width="1.6" height="17"/>`).join("")}
      <path d="M104 171.4H137V172.4H104ZM151 171.4H190V172.4H151Z"/>
      <path d="${BALUSTERS}"/>
    </g>
    <path d="M140.5 182V169.6a3.5 3.5 0 0 1 7 0V182Z" fill="#2a170c"/>
    <circle cx="146.2" cy="176" r=".45" fill="#c98b3a"/>
    <path d="M138 182h12v1.4h-12ZM136.6 183.4h14.8v1.4h-14.8Z" fill="#1c1228"/>
    <path d="M121 44L130 97.6 133.5 100.4M121 44L112 97.6 108.5 100.4M110 104H182M110 104L104 124.4M182 104L188 124.4M100 125L87 140.4M100 125L113 140.4M175 90.4H183.4M182.4 92V104M146 104.2L139 112.2M146 104.2L153 112.2M170 104.2L163 112.2M170 104.2L177 112.2M104.5 160.4H187.5" ${rim()}/>
    ${path(hill(HOUSE_HILL), `fill="url(#hill)"`)}
    ${path(crest(HOUSE_HILL), rim(0.14))}
    <path d="M141.6 186.2H146.4C150 192 156 198 162.6 204H160.4C153 198 146 192 141.6 186.2Z" fill="#2c1f40" opacity=".7"/>`;
  return house;
}

/** The lit windows: warm panes with curtains, and a figure at one of them. */
export function farEmitArt() {
  return `
    <defs>
      <linearGradient id="pane" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe7a6"/><stop offset=".6" stop-color="#ffb247"/><stop offset="1" stop-color="#f27a1e"/></linearGradient>
    </defs>
    ${WINDOWS.map((w) => path(w.d, `fill="url(#pane)"`)).join("")}
    <g fill="#7a2c0c" opacity=".7">
      ${WINDOWS.filter((w) => w.curtains)
        .map((w) => {
          const m = /M([\d.]+) ([\d.]+)h([\d.]+)v([\d.]+)/.exec(w.d);
          if (!m) return "";
          const [x, y, wd, ht] = m.slice(1).map(Number);
          return `<path d="M${x} ${y}h${wd * 0.3}q${-wd * 0.1} ${ht * 0.5} ${-wd * 0.08} ${ht * 0.9}H${x}ZM${x + wd} ${y}h${-wd * 0.3}q${wd * 0.1} ${ht * 0.5} ${wd * 0.08} ${ht * 0.9}H${x + wd}Z"/>`;
        })
        .join("")}
    </g>
    <path d="M151.2 137.6v-4.4c0-1.1.6-1.9 1.2-2.1-.6-.4-.9-1-.9-1.6 0-1 .7-1.6 1.4-1.6s1.4.6 1.4 1.6c0 .6-.3 1.2-.9 1.6.6.2 1.2 1 1.2 2.1v4.4Z" fill="#2a0d04"/>
    <path d="M135 132.4h6.4M138.2 128v9.6M163 132.4h6.4M166.2 128v9.6M113 170h7.4M116.7 166v8M171 170h7.4M174.7 166v8M95.4 150.4h7M98.9 146v9M121 110.5V117M118.5 113.6h5" stroke="#3a1606" stroke-width=".55"/>`;
}

// ---------------------------------------------------------------------------
// Middle: the hill, the dead tree, the owl's body, a stretch of iron fence.

export const MID: Hill = {
  start: [0, 188],
  curves: [
    [30, 184, 60, 192, 100, 198],
    [140, 204, 190, 202, 240, 204],
  ],
};

export function midArt() {
  const fenceXs = Array.from({ length: 18 }, (_, i) => 128 + i * 6.2).filter((x) => x < 196 || x > 208);
  const rail = (dy: number) => {
    let d = "";
    for (let x = 126; x <= 240; x += 2) d += `${x === 126 ? "M" : "L"}${x} ${(groundAt(MID, x) + dy).toFixed(2)}`;
    return d;
  };
  const fence = fenceXs
    .map((x, i) => {
      const y = groundAt(MID, x) - 17;
      const lean = i === 6 ? -9 : i === 13 ? 5 : 0;
      return `<g ${lean ? `transform="rotate(${lean} ${x} ${y + 20})"` : ""}><rect x="${x - 0.55}" y="${y.toFixed(2)}" width="1.1" height="21"/><path d="M${x} ${(y - 4).toFixed(2)}C${x + 1.1} ${(y - 2.7).toFixed(2)} ${x + 1.1} ${(y - 1).toFixed(2)} ${x} ${y.toFixed(2)}C${x - 1.1} ${(y - 1).toFixed(2)} ${x - 1.1} ${(y - 2.7).toFixed(2)} ${x} ${(y - 4).toFixed(2)}Z"/></g>`;
    })
    .join("");
  return `
    <defs>
      <linearGradient id="mid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#100919"/><stop offset=".3" stop-color="#07040c"/></linearGradient>
      <linearGradient id="bark" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#05030a"/><stop offset=".7" stop-color="#0c0715"/><stop offset="1" stop-color="#1c1330"/></linearGradient>
      <radialGradient id="owl" cx=".62" cy=".3" r=".9"><stop offset="0" stop-color="#3a2c50"/><stop offset=".6" stop-color="#1f1630"/><stop offset="1" stop-color="#110b1a"/></radialGradient>
    </defs>
    <g fill="#0b0612">
      <path d="${rail(-14)}${rail(-4)}" fill="none" stroke="#0b0612" stroke-width="1.2"/>
      ${fence}
    </g>
    ${path(hill(MID), `fill="url(#mid)"`)}
    ${path(crest(MID), rim(0.12))}
    <g fill="url(#bark)">
      <path d="M12 204C19 188 24 172 22 156 20 141 24 127 30 116 33 110 34 100 32 90H37.4C39.4 100 38.4 110 36.4 118 32.4 128 30.4 141 32.4 156 34.4 172 38.4 188 48 204Z"/>
      <path d="M6 205C10 199 15 197.6 20 198.4L22 205ZM40 204C44 199 51 198.4 58 200.6 51 201 47 202.6 45 205Z"/>
      <path d="M33 124C46 116 62 110 78 106 88 104 96 100 104 92 106 90 109 89 110.4 90 106 96 100 102 92 106.4 78 112.4 60 118.4 36 130.4Z"/>
      <path d="M77.6 106.4C81.6 100.4 83.6 94.4 81.6 86 84.8 92 86 99 82.4 106Z"/>
      <path d="M92 104.6C98 104.2 104 106.2 110.4 104 104.4 108.4 98.4 108.4 92.4 107.4Z"/>
      <path d="M59.6 112.6C59.6 104.6 55.6 98.6 57.6 90.4 61 98.4 63 104.4 63 111.4Z"/>
      <path d="M32 92C30 80 24 70 16 60 14 57 12 56 9.6 57 13.6 62 17.6 70 21.6 80 24.6 88 26.6 94 27.6 100.4Z"/>
      <path d="M35 96C40 86 46 78 54 70 56 68 58 68 59.4 69 54.4 74 49.4 82 44.4 92 42.4 96 40.4 99 38.4 102.4Z"/>
      <path d="M48 80C50 72 50 66 48 60 51.4 66 52.4 72 51.4 79.4Z"/>
      <path d="M24 140C16 134 8 130 0 128.4V133C8 134.4 14 138.4 22.4 146.4Z"/>
      <path d="M14 61C10 54 8 48 9 40 11 47 13 53 16.4 59Z"/>
    </g>
    <path d="M37.4 90C39.4 100 38.4 110 36.4 118 32.4 128 30.4 141 32.4 156 34.4 172 38.4 188 48 204M78 106C88 104 96 100 104 92 106 90 109 89 110.4 90M54 70C56 68 58 68 59.4 69M16 60C14 57 12 56 9.6 57" ${rim(.5)}/>
    <path d="M26 176c.8-3.4.6-7-.4-10M28 140c-.8-2.4-.6-4.6.4-6.6M24 190c-.4-2 0-4 .8-5.4" stroke="#241838" stroke-width=".5" fill="none" stroke-linecap="round"/>
    <ellipse cx="27.6" cy="160" rx="2.4" ry="3.4" fill="#04020a"/>
    <path d="M25.2 158.2c.6-1.9 4.2-1.9 4.8 0" stroke="#2a1c3c" stroke-width=".5" fill="none"/>
    <g>
      <ellipse cx="70" cy="99.4" rx="7.2" ry="9.6" fill="url(#owl)"/>
      <path d="M63.2 95.6c-1.2 4.6-.4 9.2 1.8 12 1.2-3.4 1.4-7.6.4-12.2Z" fill="#1d1428"/>
      <path d="M76.8 95.6c1.2 4.6.4 9.2-1.8 12-1.2-3.4-1.4-7.6-.4-12.2Z" fill="#1d1428"/>
      <ellipse cx="70" cy="101.6" rx="4.4" ry="6" fill="#4a3a62"/>
      <path d="M67.6 98.4q1 .9 2 0M70.4 98.4q1 .9 2 0M66.6 101.4q1 .9 2 0M69.4 101.4q1 .9 2 0M72.2 101.4q1 .9 2 0M67.8 104.4q1 .9 2 0M70.6 104.4q1 .9 2 0" stroke="#3a2a50" stroke-width=".5" fill="none"/>
      <path d="M77 94.6a7.2 9.6 0 0 1-2 12" ${rim(.7)}/>
      <path d="M66.8 108.6l-.4 1.6M68.6 109v1.6M71.4 109v1.6M73.2 108.6l.4 1.6" stroke="#c98b4a" stroke-width=".7" stroke-linecap="round"/>
    </g>`;
}

/** The owl's head, drawn in its sprite box (OWL_HEAD_RECT); the neck is at
 *  (11, 18). */
export function owlHeadArt() {
  return `
    <defs>
      <radialGradient id="h" cx=".62" cy=".3" r=".9"><stop offset="0" stop-color="#3a2c50"/><stop offset=".6" stop-color="#1f1630"/><stop offset="1" stop-color="#110b1a"/></radialGradient>
      <radialGradient id="eye"><stop offset="0" stop-color="#fff8c0"/><stop offset=".55" stop-color="#ffc531"/><stop offset="1" stop-color="#e07a10"/></radialGradient>
      <radialGradient id="glow"><stop offset="0" stop-color="#ffc531" stop-opacity=".55"/><stop offset="1" stop-color="#ffc531" stop-opacity="0"/></radialGradient>
    </defs>
    <path d="M4 10.4l-1.4-6.2 4.6 3.6ZM18 10.4l1.4-6.2-4.6 3.6Z" fill="#2c203c"/>
    <ellipse cx="11" cy="12" rx="7.6" ry="6.2" fill="url(#h)"/>
    <circle cx="8" cy="11.8" r="3.5" fill="#3a2c52"/>
    <circle cx="14" cy="11.8" r="3.5" fill="#3a2c52"/>
    <circle cx="8" cy="11.8" r="4.6" fill="url(#glow)"/>
    <circle cx="14" cy="11.8" r="4.6" fill="url(#glow)"/>
    <circle cx="8" cy="11.8" r="2.6" fill="url(#eye)"/>
    <circle cx="14" cy="11.8" r="2.6" fill="url(#eye)"/>
    <circle cx="8.25" cy="11.9" r="1.25" fill="#140a14"/>
    <circle cx="14.25" cy="11.9" r="1.25" fill="#140a14"/>
    <circle cx="7.5" cy="11.1" r=".5" fill="#fffbe6"/>
    <circle cx="13.5" cy="11.1" r=".5" fill="#fffbe6"/>
    <path d="M10.3 14.2h1.4l-.7 1.9Z" fill="#d09452"/>
    <path d="M18.4 9.8a7.6 6.2 0 0 1-.8 5.6" ${rim(.7)}/>`;
}

// ---------------------------------------------------------------------------
// Near: the graveyard ground, three tombstones (one with a cat on it), grass,
// and two small pumpkins keeping the big one company.

export const NEAR: Hill = {
  start: [0, 222],
  curves: [
    [40, 214, 90, 216, 130, 222],
    [170, 228, 210, 220, 240, 222],
  ],
};

export type Stone = {
  name: string;
  x: number;
  tilt: number;
  shape: string;
  lines: [string, number, number][];
  /** Highest point, including anything sitting on it, in local units. */
  top: number;
  says: string[];
  crack?: string;
};

export const STONES: Stone[] = [
  {
    name: "ie6",
    x: 28,
    tilt: -5,
    shape: "M-15 10V-26A15 15 0 0 1 15-26V10Z",
    lines: [["RIP", -29.6, 8.6], ["IE6", -18.4, 8.2]],
    top: -41,
    says: ["best viewed in IE6", "please upgrade me"],
    crack: "M10.4-30.4l-1.6 3.4 1.4 2-1.8 3.8.9 2.6",
  },
  {
    name: "jquery",
    x: 68,
    tilt: 2,
    shape: "M-13 10V-31Q0-55 13-31V10Z",
    lines: [["jQuery", -24.6, 6.6], ["2006–", -15.4, 5.8]],
    top: -64,
    says: ["$(ghost).fadeIn()", "I was the framework"],
  },
  {
    name: "todo",
    x: 106,
    tilt: 7,
    shape: "M-14 10V-16L-10-21H10L14-16V10Z",
    lines: [["TODO", -9.8, 7.8]],
    top: -21,
    says: ["fix later (2009)", "still not done"],
  },
];

/** Where a stone's foot is: 5 units under the crest. */
export const footOf = (s: Stone) => groundAt(NEAR, s.x) + 5;
/** Where its ghost hovers (the centre of the ghost's body). */
export const ghostAt = (s: Stone) => ({ x: s.x, y: footOf(s) + s.top - 14 });

const CAT = `
  <g transform="translate(0 -42.4) scale(1.25)">
    <path d="M3.6-.8C8.4-1.4 10 3.6 8.2 8.6 7.8 9.6 6.8 9.6 7 8.6 8.6 4.4 7.6.6 3.6 1Z" fill="#05030a"/>
    <path d="M-4.8 0C-6-4-5-8.2-3-10.2-2-11 2-11 3-10.2 5-8.2 6-4 4.8 0Z" fill="#05030a"/>
    <ellipse cy="-12.6" rx="3.9" ry="3.3" fill="#05030a"/>
    <path d="M-3.7-13.6L-3.6-18.2-1-15.3ZM3.7-13.6L3.6-18.2 1-15.3Z" fill="#05030a"/>
    <path d="M3.6-18.2L3.7-13.6M3.9-12.6a3.9 3.3 0 0 1-1.6 2.8M3-10.2C5-8.2 6-4 4.8 0M-3.6-18.2L-3.7-13.6" ${rim(.7)}/>
    <ellipse cx="-1.45" cy="-12.8" rx="1.05" ry=".85" fill="#d8ff6a"/>
    <ellipse cx="1.45" cy="-12.8" rx="1.05" ry=".85" fill="#d8ff6a"/>
    <rect x="-1.58" y="-13.6" width=".26" height="1.6" rx=".13" fill="#05030a"/>
    <rect x="1.32" y="-13.6" width=".26" height="1.6" rx=".13" fill="#05030a"/>
  </g>`;

function stoneArt(s: Stone) {
  const y = footOf(s);
  return `
    <g transform="translate(${s.x} ${y.toFixed(2)}) rotate(${s.tilt})">
      <path d="${s.shape}" fill="url(#stone)"/>
      <path d="${s.shape}" fill="#fff" filter="url(#tex)" opacity=".8"/>
      <path d="${s.shape}" fill="none" stroke="url(#stoneRim)" stroke-width=".7"/>
      ${s.lines
        .map(
          ([t, ly, size]) =>
            `<text y="${ly + 0.55}" font-size="${size}" fill="#7a68a0" opacity=".5" text-anchor="middle" font-family="Georgia,serif" font-weight="700" letter-spacing=".04em">${t}</text>` +
            `<text y="${ly}" font-size="${size}" fill="#05030a" text-anchor="middle" font-family="Georgia,serif" font-weight="700" letter-spacing=".04em">${t}</text>`,
        )
        .join("")}
      ${s.crack ? path(s.crack, `stroke="#1d1529" stroke-width=".7" fill="none" stroke-linejoin="round"`) : ""}
      <path d="M-14.6-7c2.2-3 6-4 9-2.4 1.6 1 1.4 2.6.2 2.8ZM13.8-6.4c-2-2.2-5-2.6-7.2-1.2-1 .7-.7 1.6.5 1.6Z" fill="#456c38" opacity=".85"/>
      ${s.name === "jquery" ? CAT : ""}
    </g>`;
}

const GRASS = (() => {
  const rand = seeded(5);
  let d = "";
  for (let x = 1; x < W; x += 1.4 + rand() * 2) {
    const y = groundAt(NEAR, x) + 0.8;
    const h = 1.6 + rand() ** 1.6 * 5.4;
    const lean = (rand() - 0.5) * 3;
    d += `M${(x - 0.7).toFixed(2)} ${y.toFixed(2)}Q${(x + lean * 0.3).toFixed(2)} ${(y - h * 0.6).toFixed(2)} ${(x + lean).toFixed(2)} ${(y - h).toFixed(2)}Q${(x + 0.2).toFixed(2)} ${(y - h * 0.45).toFixed(2)} ${(x + 0.7).toFixed(2)} ${y.toFixed(2)}Z`;
  }
  return d;
})();

function smallPumpkin(x: number, y: number, s: number, pale: boolean) {
  const [a, b] = pale ? ["url(#pale1)", "url(#pale0)"] : ["url(#pk1)", "url(#pk0)"];
  return `
    <g transform="translate(${x} ${y}) scale(${s})">
      <ellipse cy="7.4" rx="11" ry="2" fill="#000" opacity=".55"/>
      <ellipse cx="-4.6" rx="6" ry="7.2" fill="${a}"/>
      <ellipse cx="4.6" rx="6" ry="7.2" fill="${a}"/>
      <ellipse rx="5.6" ry="7.6" fill="${b}"/>
      <ellipse cx="-2.4" cy="-4.2" rx="2" ry=".9" fill="#fff4e0" opacity=".25" transform="rotate(-20 -2.4 -4.2)"/>
      <path d="M-.6-7C-.8-9.4.2-11 2-11.8L2.8-11C1.6-10.2 1.2-8.8 1.4-7Z" fill="${pale ? "#6e6e50" : "#5a5a26"}"/>
    </g>`;
}

const LEAF = "M0-3.4C.6-2.2 1.8-2.6 2.4-3 2.2-1.8 3-1.2 3.6-1 2.6-.4 2.6.4 2.8 1 1.8.6 1 1 .4 1.6V2.6H-.4V1.6C-1 1-1.8.6-2.8 1-2.6.4-2.6-.4-3.6-1-3-1.2-2.2-1.8-2.4-3-1.8-2.6-.6-2.2 0-3.4Z";

export function nearArt() {
  return `
    <defs>
      <linearGradient id="near" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b0612"/><stop offset="1" stop-color="#030205"/></linearGradient>
      <linearGradient id="stone" x1=".75" y1="0" x2=".2" y2="1"><stop offset="0" stop-color="#3e3456"/><stop offset=".35" stop-color="#1f1a2e"/><stop offset="1" stop-color="#0b0812"/></linearGradient>
      <linearGradient id="stoneRim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d8c8f8" stop-opacity=".75"/><stop offset=".35" stop-color="#d8c8f8" stop-opacity=".12"/><stop offset=".6" stop-color="#d8c8f8" stop-opacity="0"/></linearGradient>
      <filter id="tex" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="1.3 .8" numOctaves="3" seed="9"/>
        <feColorMatrix values="0 0 0 0 .1  0 0 0 0 .07  0 0 0 0 .16  0 0 0 -1.5 .95"/>
        <feComposite in2="SourceGraphic" operator="in"/>
      </filter>
      <radialGradient id="pk0" cx=".42" cy=".3" r=".8"><stop offset="0" stop-color="#f0a050"/><stop offset=".55" stop-color="#d0661a"/><stop offset="1" stop-color="#8a3406"/></radialGradient>
      <radialGradient id="pk1" cx=".45" cy=".32" r=".8"><stop offset="0" stop-color="#d07a2a"/><stop offset=".6" stop-color="#a0460c"/><stop offset="1" stop-color="#5e2204"/></radialGradient>
      <radialGradient id="pale0" cx=".42" cy=".3" r=".8"><stop offset="0" stop-color="#e8e0d2"/><stop offset=".6" stop-color="#b8aa94"/><stop offset="1" stop-color="#6e6050"/></radialGradient>
      <radialGradient id="pale1" cx=".5" cy=".34" r=".8"><stop offset="0" stop-color="#ada08a"/><stop offset="1" stop-color="#4e4436"/></radialGradient>
    </defs>
    ${STONES.map(stoneArt).join("")}
    ${path(hill(NEAR), `fill="url(#near)"`)}
    ${path(crest(NEAR), rim(0.1))}
    ${path(GRASS, `fill="#07040b"`)}
    ${[
      [148, 252, 30, 0.9, "#a8481a"],
      [160, 257, -40, 0.75, "#7a3212"],
      [212, 256, 70, 0.85, "#c07a2a"],
      [232, 250, -20, 0.7, "#9a3e18"],
      [128, 246, 110, 0.6, "#c07a2a"],
      [40, 248, 15, 0.8, "#7a3212"],
      [84, 252, -60, 0.7, "#a8481a"],
    ]
      .map(([x, y, r, s, fill]) => path(LEAF, `fill="${fill}" opacity=".85" transform="translate(${x} ${y}) rotate(${r}) scale(${s})"`))
      .join("")}
    ${smallPumpkin(144, 248, 0.75, true)}
    ${smallPumpkin(226, 247, 1, false)}`;
}

// ---------------------------------------------------------------------------
// The jack-o'-lantern, in its sprite box (PUMPKIN_RECT; centre at 50, 46).
// The body is uncarved here; each face texture paints its own holes over it,
// so the two expressions can swap without leaving the other's cuts behind.

const LOBES: [number, number, number, string][] = [
  [-17, 8, 13, "url(#p2)"],
  [17, 8, 13, "url(#p2)"],
  [-11, 10, 15.5, "url(#p1)"],
  [11, 10, 15.5, "url(#p1)"],
  [-5.5, 10.5, 16.5, "url(#p0)"],
  [5.5, 10.5, 16.5, "url(#p0)"],
  [0, 10, 17, "url(#p0)"],
];

export const FACES = {
  calm: "M-12-2H-4.5L-8.5-9.6ZM4.5-2H12L8.5-9.6ZM-1.8 2.6H1.8L0-.8ZM-13 5Q0 18 13 5 11 6.6 8.6 7L7 9.8 5 7.6Q0 8.4-5 7.6L-7 9.8-8.6 7Q-11 6.6-13 5Z",
  cackle:
    "M-12.6-3Q-8.4-10-4-3-8.4-6.4-12.6-3ZM4-3Q8.4-10 12.6-3 8.4-6.4 4-3ZM-1.8 2.6H1.8L0-.8ZM-14.4 3.6Q0 23 14.4 3.6 12.2 5.8 9.6 6.4L7.6 10.6 5.4 7.6Q0 8.8-5.4 7.6L-7.6 10.6-9.6 6.4Q-12.2 5.8-14.4 3.6Z",
};

const PUMPKIN_FRAME = `transform="translate(50 46) scale(1.3)"`;

export function pumpkinArt() {
  return `
    <defs>
      <radialGradient id="p0" cx=".42" cy=".3" r=".8"><stop offset="0" stop-color="#ffb862"/><stop offset=".55" stop-color="#f57a1c"/><stop offset="1" stop-color="#a5400a"/></radialGradient>
      <radialGradient id="p1" cx=".45" cy=".32" r=".8"><stop offset="0" stop-color="#f08a2e"/><stop offset=".6" stop-color="#c4550c"/><stop offset="1" stop-color="#7a2c04"/></radialGradient>
      <radialGradient id="p2" cx=".5" cy=".34" r=".8"><stop offset="0" stop-color="#d06418"/><stop offset=".6" stop-color="#8f3405"/><stop offset="1" stop-color="#4e1902"/></radialGradient>
      <linearGradient id="stem" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9a9a48"/><stop offset="1" stop-color="#4a4a1c"/></linearGradient>
      <linearGradient id="leaf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34521f"/><stop offset="1" stop-color="#5e8a34"/></linearGradient>
    </defs>
    <g ${PUMPKIN_FRAME}>
      <ellipse cy="17.6" rx="27" ry="3.6" fill="#000" opacity=".6"/>
      ${LOBES.map(([dx, rx, ry, fill]) => `<ellipse cx="${dx}" cy="${Math.abs(dx) * 0.06}" rx="${rx}" ry="${ry}" fill="${fill}" stroke="#6e2604" stroke-opacity=".4" stroke-width=".5"/>`).join("")}
      <ellipse cx="-7" cy="-11" rx="4.6" ry="1.8" fill="#ffe2b4" opacity=".28" transform="rotate(-22 -7 -11)"/>
      <ellipse cx="2" cy="-13" rx="2.6" ry="1.1" fill="#ffe2b4" opacity=".2" transform="rotate(-8 2 -13)"/>
      <ellipse cy="13" rx="20" ry="4" fill="#3a1202" opacity=".4"/>
      <path d="M-2.2-15.4C-2.6-20.6-.6-24.8 3.6-27L5.8-25.2C2.8-23.2 1.6-20 2.4-15.4Z" fill="url(#stem)"/>
      <ellipse cx="4.7" cy="-26.1" rx="1.5" ry=".75" fill="#b4b070" transform="rotate(-40 4.7 -26.1)"/>
      <path d="M-.6-16.4C-.8-20-.2-22.4 2-24.6M.8-16.4C.8-19.4 1.4-21.6 3.2-23.6" stroke="#3e3e18" stroke-width=".35" fill="none"/>
      <path d="M2-16.6C7-20.6 13.4-19.2 14.4-15 15.2-11.4 11.2-10.2 10.6-12.8 10.2-14.6 12.6-15.2 12.9-13.6" stroke="#4d6b2a" stroke-width=".75" fill="none" stroke-linecap="round"/>
      <path d="M-2-16.2C-5.4-20.8-11.2-21.6-14.4-18.4-11.4-17.6-9.2-15.4-8.4-13-6-15.8-3.8-16.4-2-16.2Z" fill="url(#leaf)"/>
      <path d="M-2.2-16.2C-6-17.4-9.6-17.8-13.4-18.4M-6.4-17.2l-1.6 2M-9.6-17.8l-.6 2.4" stroke="#24391a" stroke-width=".35" fill="none"/>
    </g>`;
}

/** One expression of the glowing face: lit flesh at the cut wall, then the
 *  bright interior offset down-right, so the wall shows at the top-left. */
export function faceArt(face: keyof typeof FACES) {
  const d = FACES[face];
  return `
    <defs>
      <radialGradient id="c" cx=".5" cy=".6" r=".7"><stop offset="0" stop-color="#fff8c8"/><stop offset=".4" stop-color="#ffd24a"/><stop offset="1" stop-color="#ff8a12"/></radialGradient>
      <clipPath id="k"><path d="${d}"/></clipPath>
    </defs>
    <g ${PUMPKIN_FRAME}>
      <g clip-path="url(#k)">
        <rect x="-16" y="-12" width="32" height="26" fill="#e8883a"/>
        <path d="${d}" transform="translate(.8 1.1)" fill="url(#c)"/>
      </g>
      <path d="${d}" fill="none" stroke="#5a1e02" stroke-width=".55" stroke-linejoin="round"/>
    </g>`;
}

// ---------------------------------------------------------------------------
// Ghost, bats, witch.

/** The ghost, centred at (20, 26) in its GHOST_SIZE box. */
export function ghostArt() {
  return `
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".97"/><stop offset=".65" stop-color="#efe6ff" stop-opacity=".9"/><stop offset="1" stop-color="#c6b2ff" stop-opacity=".25"/></linearGradient>
    </defs>
    <g transform="translate(20 26) scale(1.25)">
      <path d="M-8.4-4.6c-3.2.2-4.8 2.2-5.4 4.4 1.8-1.2 3.6-1.6 5.6-1.4Z" fill="url(#g)"/>
      <path d="M8.4-4.6c3.2.2 4.8 2.2 5.4 4.4-1.8-1.2-3.6-1.6-5.6-1.4Z" fill="url(#g)"/>
      <path d="M-9 6C-9-7-7-18 0-18 7-18 9-7 9 6C7 3.8 5.4 8.2 3 6 1 3.8-1 8.2-3 6-5.4 3.8-7 8.2-9 6Z" fill="url(#g)"/>
      <ellipse cx="-3.4" cy="-13" rx="2.6" ry="1.4" fill="#fff" opacity=".6"/>
      <ellipse cx="-3" cy="-8.4" rx="1.55" ry="2.1" fill="#1a1024"/>
      <ellipse cx="3" cy="-8.4" rx="1.55" ry="2.1" fill="#1a1024"/>
      <circle cx="-2.5" cy="-9.2" r=".45" fill="#fff"/>
      <circle cx="3.5" cy="-9.2" r=".45" fill="#fff"/>
      <ellipse cy="-3.4" rx="1.5" ry="1.9" fill="#1a1024"/>
      <ellipse cx="-5.4" cy="-5" rx="1.4" ry=".75" fill="#ffadc6" opacity=".55"/>
      <ellipse cx="5.4" cy="-5" rx="1.4" ry=".75" fill="#ffadc6" opacity=".55"/>
    </g>`;
}

const BAT_WING = "M1.3-1.5C3.8-4.6 8.4-6.2 12.4-4.4 11.2-2.9 10.9-1.3 11.4.6 9.8-.4 8.3-.2 7.4 1.3 6.3.1 4.6.1 3.5 1.3 3 .2 2.2-.5 1.3-.2Z";

function bat(cx: number, wing: number) {
  return `
    <g transform="translate(${cx} 7.5)" fill="#05030a">
      <g transform="rotate(${-wing})"><path d="${BAT_WING}" transform="scale(-1 1)"/></g>
      <g transform="rotate(${wing})"><path d="${BAT_WING}"/></g>
      <ellipse cy=".2" rx="2.3" ry="3.4"/>
      <circle cy="-3.1" r="2"/>
      <path d="M-1.8-4.2l-.6-2.7 1.7 1.5ZM1.8-4.2l.6-2.7-1.7 1.5Z"/>
      <circle cx="-.72" cy="-3.2" r=".4" fill="#ff9d2e"/>
      <circle cx=".72" cy="-3.2" r=".4" fill="#ff9d2e"/>
    </g>`;
}

/** Two frames side by side: wings up, wings down. */
export function batArt() {
  return bat(13, -28) + bat(39, 22);
}

export function witchArt() {
  return `
    <g transform="translate(30 25) scale(1.1)" fill="#05030a">
      <path d="M-13.5 1.6C-16 .4-19 -.6-22.5-.4-20.4.6-19.4 1.4-18.6 2.2-20.6 2.4-22.2 3.4-23.4 4.8-20 4.6-17 4.2-13.3 3.2Z"/>
      <path d="M-13 1.9L13.5-1.4 13.7-.6-12.8 2.9Z"/>
      <path d="M-1.2-6.2C-5.6-7.6-9.4-6.8-13.4-9.8-11.6-6.2-9.8-3.6-6.4-1.4-4.6-.6-2.6-.4-.6-.8Z"/>
      <path d="M-2.4.8L-.8-7.6H2.4L3.6.4Z"/>
      <path d="M1.8-5.6L7.2-.8 6.4 0 1-4.2Z"/>
      <path d="M-.6.6L2.6 3.2 6 3 6.2 3.8 2.2 4.2-1.4 1.6Z"/>
      <circle cx="1" cy="-9.6" r="2.2"/>
      <path d="M2.8-9.8L5.4-9 2.9-8.5Z"/>
      <path d="M-.8-10.4C-3.4-10.6-5.6-9.4-7.6-10.6-6.2-8.6-4-7.8-1.2-8.4Z"/>
      <path d="M-4.4-11.2L7.2-12.4 7-11.2-4.2-10.2Z"/>
      <path d="M-1.4-11.6C-.4-15 .2-18 3.8-21.8 3.4-19 3.6-15.2 4.4-12Z"/>
      <path d="M-10.6 1.8C-11 0-10.2-1.4-9-1.8L-9.4-3.4-8.2-2.4-7.2-2.6-6.8-3.6-6.4-2.2C-6-1.2-6.4.6-7.4 1.4Z"/>
      <path d="M-10.4 1C-12.4.6-13.4-1-13.4-2.8-12.6-1.6-11.8-1-10.4-.8Z"/>
      <circle cx="-8.4" cy="-1.4" r=".32" fill="#d8ff6a"/>
      <circle cx="-7.3" cy="-1.5" r=".32" fill="#d8ff6a"/>
    </g>`;
}
