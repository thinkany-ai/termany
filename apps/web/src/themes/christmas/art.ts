// The Christmas theme's artwork: a hand-drawn snowy night behind the whole
// window. It is layered SVG built from seeded noise and hand-placed shapes, so
// it redraws crisply at any window size and is the same every time.
//
// Layers, back to front: sky (moon, stars), aurora, far mountains, middle hills
// with pines and lit cabins, near hills, the snow field. In front of them, a
// tall vignette sized to the sidebar column: a lit tree, a cabin, a snowman.
// This module only builds strings (no DOM), so it can be tested in node.

/** Size of the foreground vignette; it is anchored to the sidebar's bottom-left. */
export const FORE = { w: 250, h: 360 } as const;
/** The snowman's raised hand in vignette coordinates: fireworks start here. */
export const HAND: [number, number] = [239, 237];

export type Scene = {
  /** Full-window layers, back to front, each one SVG document. */
  layers: { name: string; svg: string }[];
  /** The foreground vignette, FORE.w x FORE.h. */
  fore: string;
};

type Noise = (x: number) => number;

export function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 1-D value noise in [0, 1], smooth. */
function noise1(seed: number): Noise {
  const r = mulberry32(seed);
  const table = Array.from({ length: 512 }, () => r());
  return (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    const a = table[((i % 512) + 512) % 512];
    const b = table[(((i + 1) % 512) + 512) % 512];
    return a + (b - a) * u;
  };
}

function fbm(n: Noise, x: number, oct = 4): number {
  let v = 0, a = 0.5, f = 1, s = 0;
  for (let i = 0; i < oct; i++) {
    v += a * n(x * f + i * 17.3);
    s += a;
    a *= 0.5;
    f *= 2.03;
  }
  return v / s;
}

const n1 = (v: number) => v.toFixed(1);

function svgDoc(w: number, h: number, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${inner}</svg>`;
}

/** A ridge from a height function, closed to the bottom. */
function ridge(W: number, H: number, yAt: Noise, step = 6): string {
  let d = `M-20 ${H + 20} L-20 ${n1(yAt(-20))}`;
  for (let x = -20; x <= W + 20; x += step) d += ` L${x} ${n1(yAt(x))}`;
  return d + ` L${W + 20} ${H + 20} Z`;
}

/** Just the ridge line, for a moonlit rim. */
function ridgeLine(W: number, yAt: Noise, step = 6): string {
  let d = `M-20 ${n1(yAt(-20))}`;
  for (let x = -20; x <= W + 20; x += step) d += ` L${x} ${n1(yAt(x))}`;
  return d;
}

/** A small pine of three stacked tiers, base centred at (x, y). */
function pine(x: number, y: number, h: number): string {
  const w = h * 0.42;
  const tier = (t: number, b: number, hw: number) =>
    `M${n1(x)} ${n1(y - h * t)} L${n1(x + hw)} ${n1(y - h * b)} L${n1(x - hw)} ${n1(y - h * b)} Z`;
  return (
    tier(1, 0.52, w * 0.55) +
    tier(0.74, 0.26, w * 0.78) +
    tier(0.48, 0, w) +
    `M${n1(x - h * 0.04)} ${n1(y)} h${n1(h * 0.08)} v${n1(h * 0.1)} h${n1(-h * 0.08)} Z`
  );
}

/** A twinkle class with a stable, seeded phase. */
const twinkle = (rnd: () => number) => ` class="tw" style="animation-delay:${(-rnd() * 5).toFixed(2)}s"`;

function sky(W: number, H: number, rnd: () => number): string {
  let stars = "";
  for (let i = 0; i < 220; i++) {
    const x = rnd() * W, y = Math.pow(rnd(), 1.6) * H * 0.62, r = rnd() < 0.08 ? 1.3 : 0.5 + rnd() * 0.6;
    const tw = rnd() < 0.07 ? twinkle(rnd) : "";
    stars += `<circle cx="${n1(x)}" cy="${n1(y)}" r="${r.toFixed(2)}" fill="#e8ecff" opacity="${(0.35 + rnd() * 0.6).toFixed(2)}"${tw}/>`;
  }
  for (let i = 0; i < 9; i++) {
    const x = rnd() * W, y = rnd() * H * 0.45, s = 3 + rnd() * 4;
    stars += `<path${twinkle(rnd)} d="M${n1(x)} ${n1(y - s)} Q${n1(x)} ${n1(y)} ${n1(x + s)} ${n1(y)} Q${n1(x)} ${n1(y)} ${n1(x)} ${n1(y + s)} Q${n1(x)} ${n1(y)} ${n1(x - s)} ${n1(y)} Q${n1(x)} ${n1(y)} ${n1(x)} ${n1(y - s)} Z" fill="#fff6e0"/>`;
  }
  const mx = Math.min(170, W * 0.14), my = H * 0.2;
  return svgDoc(W, H, `
    <defs>
      <linearGradient id="xm-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#060a1c"/><stop offset=".35" stop-color="#0f1438"/>
        <stop offset=".62" stop-color="#241e52"/><stop offset=".8" stop-color="#3b2a62"/><stop offset="1" stop-color="#2a2150"/>
      </linearGradient>
      <radialGradient id="xm-moon-halo"><stop offset="0" stop-color="#cfd8ff" stop-opacity=".55"/><stop offset=".25" stop-color="#8f9de8" stop-opacity=".18"/><stop offset="1" stop-color="#8f9de8" stop-opacity="0"/></radialGradient>
      <radialGradient id="xm-moon" cx=".38" cy=".35"><stop offset="0" stop-color="#ffffff"/><stop offset=".7" stop-color="#e9ecff"/><stop offset="1" stop-color="#bfc8f2"/></radialGradient>
      <radialGradient id="xm-horizon" cx=".5" cy="1" r=".7"><stop offset="0" stop-color="#7a4a8a" stop-opacity=".45"/><stop offset="1" stop-color="#7a4a8a" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#xm-sky)"/>
    <rect y="${n1(H * 0.35)}" width="${W}" height="${n1(H * 0.5)}" fill="url(#xm-horizon)"/>
    ${stars}
    <circle cx="${n1(mx)}" cy="${n1(my)}" r="190" fill="url(#xm-moon-halo)"/>
    <circle cx="${n1(mx)}" cy="${n1(my)}" r="34" fill="url(#xm-moon)"/>
    <circle cx="${n1(mx - 9)}" cy="${n1(my + 7)}" r="5" fill="#c9d1f4" opacity=".55"/>
    <circle cx="${n1(mx + 10)}" cy="${n1(my - 9)}" r="3.5" fill="#c9d1f4" opacity=".45"/>
    <circle cx="${n1(mx + 4)}" cy="${n1(my + 14)}" r="2.5" fill="#c9d1f4" opacity=".4"/>`);
}

function aurora(W: number, H: number): string {
  const band = (y0: number, amp: number, f: number, ph: number, w: number, c1: string, c2: string, op: number) => {
    let d = `M-60 ${n1(y0)}`;
    for (let x = -60; x <= W + 60; x += 20) {
      d += ` L${x} ${n1(y0 + Math.sin(x * f + ph) * amp + Math.sin(x * f * 2.7 + ph * 1.3) * amp * 0.35)}`;
    }
    const id = `xm-aur-${Math.round(ph * 10)}`;
    return `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${c1}" stop-opacity="0"/><stop offset=".25" stop-color="${c1}"/><stop offset=".7" stop-color="${c2}"/><stop offset="1" stop-color="${c2}" stop-opacity="0"/></linearGradient>
      <path d="${d}" fill="none" stroke="url(#${id})" stroke-width="${w}" stroke-linecap="round" opacity="${op}" filter="url(#xm-aur-blur)"/>`;
  };
  return svgDoc(W, H, `
    <defs><filter id="xm-aur-blur" x="-10%" y="-50%" width="120%" height="200%"><feGaussianBlur stdDeviation="22"/></filter></defs>
    <g>
      ${band(H * 0.14, 34, 0.0045, 1.2, 70, "#3cf2a0", "#6a7cff", 0.55)}
      ${band(H * 0.24, 26, 0.006, 3.1, 46, "#26d6a8", "#b06aff", 0.38)}
      ${band(H * 0.08, 20, 0.0035, 5.0, 40, "#6a7cff", "#3cf2a0", 0.3)}
    </g>`);
}

function landscape(W: number, H: number, rnd: () => number): { name: string; svg: string }[] {
  const nFar = noise1(11), nMid = noise1(23), nNear = noise1(37);
  const farY: Noise = (x) => H * 0.58 - Math.pow(1 - Math.abs(2 * fbm(nFar, x / 170, 4) - 1), 2.2) * 170 - fbm(nFar, x / 420 + 9, 2) * 60;
  const midY: Noise = (x) => H * 0.7 - fbm(nMid, x / 160, 3) * 70;
  const nearY: Noise = (x) => H * 0.8 - fbm(nNear, x / 130, 3) * 55;
  const fieldY: Noise = (x) => H * 0.9 - fbm(nNear, x / 220 + 40, 2) * 22;
  // Snow caps on the far peaks: the ridge, down to a ragged line below it.
  const capY: Noise = (x) => farY(x) + 26 + fbm(nFar, x / 30 + 3, 2) * 18;
  let capD = `M-20 ${n1(farY(-20))}`;
  for (let x = -20; x <= W + 20; x += 6) capD += ` L${x} ${n1(farY(x))}`;
  for (let x = W + 20; x >= -20; x -= 6) capD += ` L${x} ${n1(capY(x))}`;
  capD += " Z";

  const far = svgDoc(W, H, `
    <defs>
      <linearGradient id="xm-far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b3a7a"/><stop offset="1" stop-color="#26265a"/></linearGradient>
      <linearGradient id="xm-cap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b9c0f0"/><stop offset="1" stop-color="#6b6eb0" stop-opacity="0"/></linearGradient>
      <linearGradient id="xm-haze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a7fd0" stop-opacity="0"/><stop offset=".5" stop-color="#8a7fd0" stop-opacity=".22"/><stop offset="1" stop-color="#8a7fd0" stop-opacity="0"/></linearGradient>
    </defs>
    <path d="${ridge(W, H, farY)}" fill="url(#xm-far)"/>
    <path d="${capD}" fill="url(#xm-cap)" opacity=".75"/>
    <path d="${ridgeLine(W, farY, 4)}" fill="none" stroke="#c9cff8" stroke-width="1.3" opacity=".55"/>
    <rect y="${n1(H * 0.5)}" width="${W}" height="${n1(H * 0.2)}" fill="url(#xm-haze)"/>`);

  let midPines = "";
  for (let x = -10; x < W + 10; x += 6 + rnd() * 16) if (fbm(nMid, x / 90 + 5, 2) > 0.42) midPines += pine(x, midY(x) + 3, 14 + rnd() * 14);
  const cabins = [0.33, 0.47, 0.71, 0.86].map((f) => {
    const x = W * f, y = midY(W * f) + 2;
    return `<rect x="${n1(x - 5)}" y="${n1(y - 6)}" width="10" height="7" fill="#151634"/><path d="M${n1(x - 7)} ${n1(y - 5)} L${n1(x)} ${n1(y - 11)} L${n1(x + 7)} ${n1(y - 5)} Z" fill="#8f96c8"/><rect x="${n1(x - 2)}" y="${n1(y - 4)}" width="3" height="3" fill="#ffcf73"/><circle cx="${n1(x - 0.5)}" cy="${n1(y - 2.5)}" r="9" fill="url(#xm-far-light)"/>`;
  }).join("");
  const mid = svgDoc(W, H, `
    <defs><linearGradient id="xm-mid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#232552"/><stop offset="1" stop-color="#1a1b42"/></linearGradient>
      <radialGradient id="xm-far-light"><stop offset="0" stop-color="#ffcf73" stop-opacity=".55"/><stop offset="1" stop-color="#ffcf73" stop-opacity="0"/></radialGradient>
      <linearGradient id="xm-haze2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6d63b8" stop-opacity="0"/><stop offset=".6" stop-color="#6d63b8" stop-opacity=".18"/><stop offset="1" stop-color="#6d63b8" stop-opacity="0"/></linearGradient></defs>
    <path d="${ridge(W, H, midY)}" fill="url(#xm-mid)"/>
    <path d="${ridgeLine(W, midY)}" fill="none" stroke="#6f74c0" stroke-width="1.2" opacity=".5"/>
    <path d="${midPines}" fill="#191a40"/>
    ${cabins}
    <rect y="${n1(H * 0.64)}" width="${W}" height="${n1(H * 0.16)}" fill="url(#xm-haze2)"/>`);

  let nearPines = "";
  for (let x = -10; x < W + 10; x += 8 + rnd() * 20) if (fbm(nNear, x / 70 + 2, 2) > 0.38) nearPines += pine(x, nearY(x) + 4, 24 + rnd() * 26);
  const near = svgDoc(W, H, `
    <path d="${ridge(W, H, nearY)}" fill="#141637"/>
    <path d="${ridgeLine(W, nearY)}" fill="none" stroke="#4a4f98" stroke-width="1.1" opacity=".45"/>
    <path d="${nearPines}" fill="#10122e"/>`);

  let sparkle = "";
  for (let i = 0; i < 60; i++) {
    const x = rnd() * W, y = fieldY(x) + 4 + rnd() * (H - fieldY(x));
    sparkle += `<circle${i < 8 ? twinkle(rnd) : ""} cx="${n1(x)}" cy="${n1(y)}" r="${(0.6 + rnd() * 0.8).toFixed(2)}" fill="#ffffff"/>`;
  }
  const field = svgDoc(W, H, `
    <defs><linearGradient id="xm-field" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#aab6e2"/><stop offset=".25" stop-color="#7f8cc0"/><stop offset="1" stop-color="#4c5690"/></linearGradient></defs>
    <path d="${ridge(W, H, fieldY)}" fill="url(#xm-field)"/>
    <path d="${ridgeLine(W, (x) => fieldY(x) + 1.5)}" fill="none" stroke="#e6ecff" stroke-width="1.2" opacity=".7"/>
    ${sparkle}`);

  return [
    { name: "far", svg: far },
    { name: "mid", svg: mid },
    { name: "near", svg: near },
    { name: "field", svg: field },
  ];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const P = (p: Pt) => `${n1(p[0])} ${n1(p[1])}`;

const BAUBLE_STOPS = [
  ["#ff8a95", "#d22a40", "#6e1020"],
  ["#fff2a8", "#e8b23a", "#7d520e"],
  ["#ffffff", "#c6d0f0", "#5f6b9e"],
  ["#b2e0ff", "#3f8fd8", "#173e78"],
];

/**
 * A snowy fir, tiers drawn bottom up. Each tier droops in branch tips, the
 * tier above shades it, and snow rests on the moonlit (left) branches.
 */
function fir(tx: number): { defs: string; body: string; lights: string } {
  const tiers: [number, number, number][] = [[184, 264, 60], [150, 224, 51], [121, 186, 42], [95, 150, 33], [73, 117, 24], [57, 91, 14]];
  const colors = ["#ff5a66", "#ffd166", "#6fb6ff", "#8ef0b4"];
  let defs = BAUBLE_STOPS.map(([a, b, c], i) =>
    `<radialGradient id="xm-bb${i}" cx=".36" cy=".32" r=".75"><stop offset="0" stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></radialGradient>`,
  ).join("");
  let body = "", wires = "", bulbs = "", baubles = "", nLight = 0;
  tiers.forEach(([top, bot, hw], i) => {
    const r = mulberry32(90 + i);
    const n = Math.max(3, Math.round(hw / 7.5) + 1);
    const tips: Pt[] = [];
    for (let k = 0; k < n; k++) {
      const u = -1 + (2 * k) / (n - 1);
      tips.push([tx + u * hw + (k && k < n - 1 ? (r() - 0.5) * 3 : 0), bot + 3 - u * u * 5 + r() * 2.5]);
    }
    const notches: Pt[] = [];
    for (let k = 0; k < n - 1; k++) {
      notches.push([(tips[k][0] + tips[k + 1][0]) / 2 + (r() - 0.5) * 1.5, (tips[k][1] + tips[k + 1][1]) / 2 - 5 - r() * 2.5]);
    }
    // Short branch ends poke out of the sides between the apex and the outer tips.
    const side = (to: Pt, dir: number) => {
      const m = hw > 30 ? 2 : 1, pts: Pt[] = [];
      for (let j = 1; j <= m; j++) {
        const f = j / (m + 1), g = f + 0.3 / (m + 1);
        pts.push([lerp(tx, to[0], f) + dir * 2.6, lerp(top, to[1], f) + 1.5]);
        pts.push([lerp(tx, to[0], g) - dir * 1.2, lerp(top, to[1], g)]);
      }
      return pts;
    };
    let d = `M${tx} ${top} ` + side(tips[n - 1], 1).map((p) => `L${P(p)}`).join(" ") + ` L${P(tips[n - 1])}`;
    for (let k = n - 1; k > 0; k--) {
      const T = tips[k], N = notches[k - 1], T2 = tips[k - 1];
      d += ` Q${n1(lerp(T[0], N[0], 0.6))} ${n1(T[1] - (T[1] - N[1]) * 0.25)} ${P(N)}`;
      d += ` Q${n1(lerp(T2[0], N[0], 0.6))} ${n1(T2[1] - (T2[1] - N[1]) * 0.25)} ${P(T2)}`;
    }
    d += " " + side(tips[0], -1).reverse().map((p) => `L${P(p)}`).join(" ") + " Z";

    const up = tiers[i + 1];
    if (up) defs += `<linearGradient id="xm-fir-sh${i}" gradientUnits="userSpaceOnUse" x1="0" y1="${up[1] - 2}" x2="0" y2="${up[1] + 16}"><stop offset="0" stop-color="#03140e" stop-opacity=".62"/><stop offset="1" stop-color="#03140e" stop-opacity="0"/></linearGradient>`;

    // Branch ribs from the trunk out to each tip; the moonlit ones get a rim.
    let ribs = "", rims = "", snow = "", snowShade = "";
    // Short creases near each tip, not from the trunk, so a tier reads as boughs.
    const sy = lerp(top, bot, 0.6);
    tips.forEach(([x, y]) => {
      const sx = tx + (x - tx) * 0.5 + (r() - 0.5) * 3, cx = tx + (x - tx) * 0.82, cy = lerp(sy, y, 0.25);
      ribs += `M${n1(sx)} ${n1(sy + r() * 3)} Q${n1(cx)} ${n1(cy)} ${n1(x)} ${n1(y - 2.5)}`;
      if (x < tx - 2) rims += `M${n1(sx + 1)} ${n1(sy - 0.6)} Q${n1(cx)} ${n1(cy - 1.3)} ${n1(x + 1)} ${n1(y - 3.8)}`;
    });
    // A few flakes caught on the moonlit side of the tier.
    const y0v = up ? up[1] + 2 : top + 4;
    for (let k = 0; k < Math.round(hw / 9); k++) {
      const y = lerp(y0v, bot - 6, r()), half = (hw * (y - top)) / (bot - top);
      snow += `<ellipse cx="${n1(tx - half * (0.25 + r() * 0.65))}" cy="${n1(y)}" rx="${n1(1.2 + r() * 1.2)}" ry="${n1(0.7 + r() * 0.5)}" fill="#eef3ff" opacity=".8"/>`;
    }
    const span = (2 * hw) / (n - 1);
    tips.forEach((T, k) => {
      const lit = (1 - (T[0] - tx) / hw) / 2;
      if (lit < 0.2 || (lit < 0.75 && r() < 0.22)) return;
      const NL = notches[k - 1] ?? [T[0] - 1, T[1] - 4], NR = notches[k] ?? [T[0] + span / 2, T[1] - 7];
      const a: Pt = [lerp(T[0], NL[0], 0.72), lerp(T[1], NL[1], 0.72) - 1.6];
      const b: Pt = [lerp(T[0], NR[0], 0.72), lerp(T[1], NR[1], 0.72) - 1.6];
      const th = (1.2 + lit * 2.6) * (0.6 + r() * 0.8);
      const under = `M${P(a)} Q${n1(T[0])} ${n1(T[1] - 1)} ${P(b)}`;
      snow += `<path d="${under} Q${n1(T[0] + 0.8)} ${n1(Math.min(a[1], b[1]) - th * 1.6)} ${P(a)} Z" fill="${lit > 0.45 ? "url(#xm-bough-snow)" : "#b2bfe8"}"/>`;
      snowShade += under;
    });
    body += `<path d="${d}" fill="url(#xm-pine)"/>${up ? `<path d="${d}" fill="url(#xm-fir-sh${i})"/>` : ""}`;
    body += `<path d="${ribs}" fill="none" stroke="#08241a" stroke-width="1" opacity=".32" stroke-linecap="round"/>`;
    if (rims) body += `<path d="${rims}" fill="none" stroke="#8fe0b0" stroke-width=".7" opacity=".22" stroke-linecap="round"/>`;
    body += `<path d="${snowShade}" fill="none" stroke="#06231a" stroke-width="1.1" opacity=".26" transform="translate(0 .9)"/>${snow}`;

    // A string of lights swags across the tier, its ends inside the outline.
    const nb = [10, 9, 7, 6, 4, 0][i];
    if (nb) {
      const halfAt = (y: number) => (hw * (y - top)) / (bot - top);
      const yA = bot - (bot - top) * 0.24, yC = bot - (bot - top) * 0.5;
      const A: Pt = [tx - halfAt(yA) * 0.9, yA], B: Pt = [tx - hw * 0.08, bot + 1], C: Pt = [tx + halfAt(yC) * 0.86, yC];
      wires += `M${P(A)} Q${P(B)} ${P(C)}`;
      for (let k = 0; k < nb; k++) {
        const t = (k + 0.5) / nb;
        const x = (1 - t) ** 2 * A[0] + 2 * (1 - t) * t * B[0] + t * t * C[0];
        const y = (1 - t) ** 2 * A[1] + 2 * (1 - t) * t * B[1] + t * t * C[1];
        const c = colors[nLight % 4];
        bulbs += `<g class="bulb" style="--c:${c};animation-delay:${(-(nLight * 0.53) % 2.6).toFixed(2)}s"><circle cx="${n1(x)}" cy="${n1(y)}" r="2.3" fill="${c}"/><circle cx="${n1(x - 0.6)}" cy="${n1(y - 0.7)}" r=".8" fill="#ffffff" opacity=".85"/></g>`;
        nLight++;
      }
    }
    // Baubles hang in the part of the tier the tier above leaves visible.
    const nBaubles = [4, 3, 3, 2, 1, 0][i];
    const y0 = up ? up[1] + 3 : top + 6, y1 = bot - 7;
    for (let k = 0; k < nBaubles; k++) {
      const y = lerp(y0, y1, 0.25 + r() * 0.6), half = (hw * (y - top)) / (bot - top) * 0.76;
      const x = tx - half + 2 * half * ((k + 0.3 + r() * 0.4) / nBaubles);
      const c = (i + k) % 4;
      baubles += `<path d="M${n1(x)} ${n1(y - 6.5)} v2" stroke="#c8a24a" stroke-width=".5"/><rect x="${n1(x - 1.1)}" y="${n1(y - 4.9)}" width="2.2" height="1.6" rx=".4" fill="#d9b25a"/><circle cx="${n1(x)}" cy="${n1(y)}" r="3.6" fill="url(#xm-bb${c})"/><ellipse cx="${n1(x - 1.2)}" cy="${n1(y - 1.4)}" rx="1.1" ry=".7" fill="#ffffff" opacity=".9"/>`;
    }
  });
  return {
    defs,
    body: body + baubles,
    lights: `<path d="${wires}" fill="none" stroke="#e8c46a" stroke-width=".7" opacity=".5"/>${bulbs}`,
  };
}

/** A faceted five-point star: each arm has a lit face and a shaded face. */
function star(cx: number, cy: number, R: number, r0: number): string {
  const pt = (k: number): Pt => {
    const a = ((-90 + k * 36) * Math.PI) / 180, rr = k % 2 ? r0 : R;
    return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
  };
  let faces = "", outline = "";
  for (let k = 0; k < 10; k++) {
    faces += `<path d="M${cx} ${cy} L${P(pt(k))} L${P(pt(k + 1))} Z" fill="${k % 2 ? "#fff6c8" : "#f7b440"}"/>`;
    outline += `${k ? "L" : "M"}${P(pt(k))} `;
  }
  return `<path class="tw" d="M${cx} ${cy - 24} L${cx + 1} ${cy} L${cx} ${cy + 22} L${cx - 1} ${cy} Z M${cx - 19} ${cy} L${cx} ${cy - 0.8} L${cx + 19} ${cy} L${cx} ${cy + 0.8} Z" fill="#fff8dc" opacity=".7"/>${faces}<path d="${outline}Z" fill="none" stroke="#fff5c8" stroke-width=".7" stroke-linejoin="round"/><circle cx="${cx}" cy="${cy}" r="1.3" fill="#ffffff"/>`;
}

/** A small pine with snow on the moonlit side of each tier, for the backdrop. */
function snowyPine(x: number, y: number, h: number): { body: string; snow: string } {
  const w = h * 0.42;
  let snow = "";
  for (const [b, hw] of [[0.52, w * 0.55], [0.26, w * 0.78], [0, w]] as const) {
    const yb = y - h * b;
    snow += `M${n1(x - hw)} ${n1(yb)} Q${n1(x - hw * 0.5)} ${n1(yb - 2.6)} ${n1(x + hw * 0.1)} ${n1(yb - 1.2)} Q${n1(x - hw * 0.45)} ${n1(yb + 0.3)} ${n1(x - hw)} ${n1(yb)} Z`;
  }
  return { body: pine(x, y, h), snow };
}

/** A candle lantern standing in the snow, base centred at (x, y). */
function lantern(x: number, y: number): string {
  return `<g class="pathlamp"><circle cx="${x}" cy="${y - 6}" r="17" fill="url(#xm-warm-halo)" opacity=".7"/>
    <ellipse cx="${x + 2}" cy="${y + 1}" rx="9" ry="2.4" fill="#ffb35c" opacity=".35" filter="url(#xm-soft)"/>
    <path d="M${x - 3.6} ${y} h7.2 v-1.6 h-7.2 Z" fill="#26212e"/>
    <rect x="${x - 3}" y="${y - 9.5}" width="6" height="8" fill="#ffd98a" opacity=".92"/>
    <path d="M${x} ${y - 7.6} q1.3 1.8 0 3.2 q-1.3 -1.4 0 -3.2 Z" fill="#fffbe6"/>
    <path d="M${x - 3} ${y - 9.5} v8 M${x + 3} ${y - 9.5} v8 M${x} ${y - 9.5} v1.4" stroke="#26212e" stroke-width=".9"/>
    <path d="M${x - 4.2} ${y - 9.3} L${x} ${y - 13} L${x + 4.2} ${y - 9.3} Z" fill="#26212e"/>
    <path d="M${x - 4.4} ${y - 9.6} Q${x - 1} ${y - 14.4} ${x + 1.5} ${y - 12.6} Q${x - 1} ${y - 11} ${x - 4.4} ${y - 9.6} Z" fill="#f4f7ff"/>
    <path d="M${x - 1.3} ${y - 13} a1.3 1.3 0 1 1 2.6 0" fill="none" stroke="#26212e" stroke-width=".7"/>
    <ellipse cx="${x - 0.5}" cy="${y + 0.3}" rx="5" ry="1.3" fill="#f4f7ff"/></g>`;
}

/** A wrapped gift sitting in the snow, base centred at (x, y). */
function gift(x: number, y: number, w: number, h: number, box: string, ribbon: string): string {
  const l = x - w / 2;
  return `<g><rect x="${n1(l)}" y="${n1(y - h)}" width="${w}" height="${h}" fill="${box}"/>
    <rect x="${n1(l)}" y="${n1(y - h)}" width="${w}" height="${h}" fill="url(#xm-gift-shade)"/>
    <rect x="${n1(l - 1)}" y="${n1(y - h - 3)}" width="${w + 2}" height="3.4" rx=".6" fill="${box}"/>
    <rect x="${n1(l - 1)}" y="${n1(y - h - 3)}" width="${w + 2}" height="3.4" rx=".6" fill="url(#xm-gift-shade)"/>
    <rect x="${n1(x - 1.4)}" y="${n1(y - h - 3)}" width="2.8" height="${h + 3}" fill="${ribbon}"/>
    <rect x="${n1(l)}" y="${n1(y - h * 0.55)}" width="${w}" height="2.4" fill="${ribbon}"/>
    <path d="M${n1(x)} ${n1(y - h - 3)} c-2 -5 -7 -4.6 -5.4 -1.2 c.8 1.6 3.4 1.6 5.4 1.2 c2 .4 4.6 .4 5.4 -1.2 c1.6 -3.4 -3.4 -3.8 -5.4 1.2 Z" fill="${ribbon}"/>
    <path d="M${n1(l - 1)} ${n1(y - h - 2.6)} q${n1(w * 0.3)} -2.6 ${n1(w * 0.55)} -.4 q${n1(w * 0.12)} -1 ${n1(w * 0.3)} 0 l0 1.2 l${n1(-w - 1)} 0 Z" fill="#f4f7ff" opacity=".95"/>
    <ellipse cx="${n1(x + 1)}" cy="${n1(y)}" rx="${n1(w * 0.62)}" ry="1.8" fill="#eef2ff"/></g>`;
}

/**
 * The foreground vignette. Moonlight comes from the upper left, so shadows
 * fall to the right; the windows, porch, lanterns and tree light the snow.
 */
function foreground(rnd: () => number): string {
  const { w: FW, h: FH } = FORE;
  const tx = 62; // tree centre
  const tree = fir(tx);
  const groundY = (x: number) => 266 + x * 0.05;
  const drift = `C 50 ${n1(groundY(50) - 4)}, 120 ${n1(groundY(120) + 6)}, 180 ${n1(groundY(180))} C 220 ${n1(groundY(220) - 4)}, 245 ${n1(groundY(245))}, 275 ${n1(groundY(275) + 2)}`;

  // A trodden path from the door to the bottom edge, wider as it comes near.
  const pathPt = (t: number): Pt => {
    const [a, b, c, d] = [[152, 272], [149, 302], [118, 322], [96, 364]] as const;
    const m = 1 - t;
    return [m ** 3 * a[0] + 3 * m * m * t * b[0] + 3 * m * t * t * c[0] + t ** 3 * d[0], m ** 3 * a[1] + 3 * m * m * t * b[1] + 3 * m * t * t * c[1] + t ** 3 * d[1]];
  };
  const left: Pt[] = [], right: Pt[] = [];
  for (let k = 0; k <= 12; k++) {
    const t = k / 12, [x, y] = pathPt(t), hw = 5 + t * 9;
    left.push([x - hw, y]);
    right.push([x + hw, y]);
  }
  const trail = `M${left.map(P).join(" L")} L${right.reverse().map(P).join(" L")} Z`;
  let steps = "";
  for (let k = 1; k < 9; k++) {
    const t = k / 9, [x, y] = pathPt(t), s = 1 + t * 0.7;
    steps += `<ellipse cx="${n1(x + (k % 2 ? 2.4 : -2.4) * s)}" cy="${n1(y)}" rx="${n1(2.2 * s)}" ry="${n1(1.1 * s)}"/>`;
  }

  let snowGlints = "";
  for (let i = 0; i < 30; i++) snowGlints += `<circle${i < 8 ? twinkle(rnd) : ""} cx="${n1(rnd() * FW)}" cy="${n1(groundY(120) + 10 + rnd() * 75)}" r="${(0.6 + rnd() * 0.8).toFixed(2)}"/>`;
  const logs = Array.from({ length: 8 }, (_, i) => `<line x1="104" x2="200" y1="${n1(220 + i * 6.5)}" y2="${n1(220 + i * 6.5)}"/>`).join("");
  const logEnds = Array.from({ length: 7 }, (_, i) => {
    const y = n1(223 + i * 6.5);
    return `<circle cx="104" cy="${y}" r="2.6"/><circle cx="200" cy="${y}" r="2.6"/>`;
  }).join("");
  const stones = Array.from({ length: 9 }, (_, i) => `<ellipse cx="${108 + i * 11.2}" cy="${266.5 + (i % 2) * 0.8}" rx="5.6" ry="2.9"/>`).join("");
  // The side wall's logs recede to the right, towards the back corner.
  const sideLogs = Array.from({ length: 8 }, (_, i) => `<line x1="200" x2="232" y1="${n1(220 + i * 6.5)}" y2="${n1(210.5 + i * 6.6)}"/>`).join("");
  const smoke = [0, 1, 2, 3, 4].map((i) => `<circle cx="203" cy="138" r="${6 + i}" fill="#b4bbe0" style="animation-delay:${-i * 1.4}s"/>`).join("");
  const back = [snowyPine(118, 222, 64), snowyPine(140, 218, 50), snowyPine(230, 226, 72), snowyPine(208, 222, 46), snowyPine(14, 214, 54)];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${FW}" height="${FH}" viewBox="0 0 ${FW} ${FH}" overflow="visible">
    <defs>
      <linearGradient id="xm-pine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3f9670"/><stop offset=".42" stop-color="#235f49"/><stop offset="1" stop-color="#103024"/></linearGradient>
      <linearGradient id="xm-bough-snow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d4ddf6"/></linearGradient>
      <linearGradient id="xm-trunk" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6a3e28"/><stop offset="1" stop-color="#2e1a12"/></linearGradient>
      <linearGradient id="xm-snow-front" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6f8ff"/><stop offset=".3" stop-color="#d9e0f7"/><stop offset="1" stop-color="#8794c9"/></linearGradient>
      <linearGradient id="xm-snow-back" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c0c9ee"/><stop offset="1" stop-color="#6c79b4"/></linearGradient>
      <linearGradient id="xm-drift" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".35" stop-color="#e2e8fa"/><stop offset="1" stop-color="#a3afe0"/></linearGradient>
      <linearGradient id="xm-wall" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#9a4e36"/><stop offset="1" stop-color="#5e2a1f"/></linearGradient>
      <linearGradient id="xm-side-wall" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4f2219"/><stop offset="1" stop-color="#3a1913"/></linearGradient>
      <linearGradient id="xm-roof-snow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#c9d3f2"/></linearGradient>
      <linearGradient id="xm-roof-side" gradientUnits="userSpaceOnUse" x1="168" y1="152" x2="232" y2="212"><stop offset="0" stop-color="#dce3f8"/><stop offset=".55" stop-color="#aab6e3"/><stop offset="1" stop-color="#8592c8"/></linearGradient>
      <linearGradient id="xm-gift-shade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff" stop-opacity=".18"/><stop offset=".5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".32"/></linearGradient>
      <linearGradient id="xm-spill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc06a" stop-opacity=".75"/><stop offset="1" stop-color="#ffc06a" stop-opacity="0"/></linearGradient>
      <linearGradient id="xm-hat" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3d3d58"/><stop offset=".4" stop-color="#22222f"/><stop offset="1" stop-color="#121219"/></linearGradient>
      <linearGradient id="xm-carrot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb060"/><stop offset="1" stop-color="#e0661c"/></linearGradient>
      <radialGradient id="xm-warm-pool"><stop offset="0" stop-color="#ffb35c" stop-opacity=".8"/><stop offset=".45" stop-color="#ff9a40" stop-opacity=".28"/><stop offset="1" stop-color="#ff9a40" stop-opacity="0"/></radialGradient>
      <radialGradient id="xm-warm-halo"><stop offset="0" stop-color="#fff0b8" stop-opacity="1"/><stop offset=".22" stop-color="#ffcf6a" stop-opacity=".55"/><stop offset="1" stop-color="#ffb24a" stop-opacity="0"/></radialGradient>
      <radialGradient id="xm-tree-glow"><stop offset="0" stop-color="#ffcf7a" stop-opacity=".32"/><stop offset="1" stop-color="#ffcf7a" stop-opacity="0"/></radialGradient>
      <radialGradient id="xm-snowman" cx=".34" cy=".3" r=".72"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#eaeffc"/><stop offset=".85" stop-color="#b9c3e8"/><stop offset="1" stop-color="#8e9ad0"/></radialGradient>
      <radialGradient id="xm-hare" cx=".35" cy=".3"><stop offset="0" stop-color="#e4def0"/><stop offset=".7" stop-color="#b3a9c8"/><stop offset="1" stop-color="#7f7699"/></radialGradient>
      <radialGradient id="xm-coal" cx=".35" cy=".3"><stop offset="0" stop-color="#55556a"/><stop offset="1" stop-color="#121218"/></radialGradient>
      <filter id="xm-smoke-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.2"/></filter>
      <filter id="xm-soft" x="-30%" y="-100%" width="160%" height="300%"><feGaussianBlur stdDeviation="1.6"/></filter>
      <filter id="xm-soft4" x="-40%" y="-100%" width="180%" height="300%"><feGaussianBlur stdDeviation="3.5"/></filter>
      <linearGradient id="xm-window" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff1b0"/><stop offset="1" stop-color="#ffb24a"/></linearGradient>
      ${tree.defs}
    </defs>

    <path d="M-10 ${FH} L-10 214 C 50 196, 140 196, 275 225 L275 ${FH} Z" fill="url(#xm-snow-back)" opacity=".7"/>
    <path d="M-10 214 C 50 196, 140 196, 275 225" fill="none" stroke="#dfe6ff" stroke-width="1" opacity=".35"/>
    <path d="${back.map((p) => p.body).join("")}" fill="#15254c"/>
    <path d="${back.map((p) => p.snow).join("")}" fill="#9fb0e4" opacity=".55"/>

    <g class="cabin">
      <path d="M200 214 L232 204 L232 264 L200 270 Z" fill="url(#xm-side-wall)"/>
      <g stroke="#2a110c" stroke-width=".9" opacity=".55">${sideLogs}</g>
      <path d="M200 214 L232 204 L232 213 L200 224 Z" fill="#1d0f0c" opacity=".45"/>
      <path d="M152 157 L184 147 L250 206 L218 216 Z" fill="url(#xm-roof-side)"/>
      <path d="M184 147 Q190 150 197 156.6 L250 206" fill="none" stroke="#eef2ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M200 167 q8 1 14 9 M222 188 q6 1 10 7" fill="none" stroke="#f4f7ff" stroke-width="1.2" opacity=".5" stroke-linecap="round"/>
      <path d="M218 216 L250 206 L250 210.5 L218 221 Z" fill="#2b1f2e"/>
      <path d="M220 218 l1.4 5 l1.4 -5 M229 215.4 l1.2 6 l1.2 -6 M237 213 l1 4 l1 -4 M244.6 210.6 l1 5 l1 -5" fill="#d6dff8"/>
      <path d="M152 157 L184 147" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round"/>
      <path d="M196 151 h12 v34 h-12 Z" fill="#5a4656"/><path d="M208 151 l4 -1.2 v33 l-4 2.2 Z" fill="#3a2b38"/>
      <path d="M196 160 h12 M196 169 h12 M196 178 h12 M202 151 v9 M199 160 v9 M205 169 v9 M202 178 v7" stroke="#3a2b38" stroke-width=".8"/>
      <path d="M193 186 q9 -6 21 -3 q-2 4 -10 5 q-7 .4 -11 -2 Z" fill="#e4eaff"/>
      <path d="M193.6 147 q.4 -3.4 4 -3.6 h11.6 q4 .2 4.4 3.4 q-.6 3 -4 3.4 h-12 q-3.6 -.4 -4 -3.2 Z" fill="#f4f7ff"/>
      <path d="M196 150.6 h16" stroke="#aab6e2" stroke-width=".8" opacity=".7"/>
      <g class="woodpile">
        <path d="M234 276 h16 v-12 q-8 -4 -16 0 Z" fill="#3a1d14"/>
        <g fill="#b0714c" stroke="#5e2a1f" stroke-width=".6"><circle cx="237" cy="273" r="2.6"/><circle cx="242.4" cy="273" r="2.6"/><circle cx="247.8" cy="273" r="2.6"/><circle cx="239.7" cy="268.4" r="2.6"/><circle cx="245.1" cy="268.4" r="2.6"/></g>
        <path d="M233 266 q4 -5.4 9.6 -4.6 q5.6 -.6 8.6 4.2 q-4 1.6 -9 .8 q-5.4 1.2 -9.2 -.4 Z" fill="#eef2ff"/>
      </g>
      <path d="M104 214 L152 172 L200 214 L200 270 L104 270 Z" fill="url(#xm-wall)"/>
      <g stroke="#4a1f17" stroke-width="1" opacity=".5">${logs}</g>
      <g fill="#b0714c" stroke="#5e2a1f" stroke-width=".8">${logEnds}</g>
      <g fill="#5d6388" stroke="#3f4566" stroke-width=".6">${stones}</g>
      <path d="M90 216 L152 162 L214 216 L206 221 L152 173 L98 221 Z" fill="#2b1f2e"/>
      <path d="M98 221 L152 173 L206 221 L200 226 L152 184 L104 226 Z" fill="#1d0f0c" opacity=".35"/>
      <path d="M86 216 L152 157 L218 216 C 215 225 208 222 205 218 L152 170 L99 218 C 95 224 89 224 86 216 Z" fill="url(#xm-roof-snow)"/>
      <path d="M92 222 l2 9 l2 -9 M104 212 l1.6 6 l1.6 -6 M118 199 l1.4 5 l1.4 -5 M190 205 l1.4 6 l1.4 -6 M208 222 l2 10 l2 -10" fill="#e6eeff"/>
      <g filter="url(#xm-soft4)" opacity=".55"><rect x="110" y="223" width="28" height="25" fill="#ffb24a"/><rect x="166" y="223" width="28" height="25" fill="#ffb24a"/><circle cx="152" cy="192" r="10" fill="#ffb24a"/></g>
      <circle class="window" cx="152" cy="192" r="7.5" fill="url(#xm-window)"/><path d="M152 184.5 v15 M144.5 192 h15" stroke="#5e2a1f" stroke-width="1.3"/>
      <g class="window"><rect x="113" y="226" width="22" height="19" rx="1.5" fill="url(#xm-window)"/><rect x="169" y="226" width="22" height="19" rx="1.5" fill="url(#xm-window)"/></g>
      <path d="M113 226 h5 l-2 19 h-3 Z M135 226 h-5 l2 19 h3 Z M169 226 h5 l-2 19 h-3 Z M191 226 h-5 l2 19 h3 Z" fill="#b8402e" opacity=".85"/>
      <path d="M182 244 l-4 0 l4 -11 l4 11 Z" fill="#7a3a12" opacity=".75"/><circle cx="182" cy="232.5" r="1.1" fill="#fff6cc"/>
      <path d="M124 245 v-4.5 M122.6 240.5 h2.8" stroke="#fff7d6" stroke-width="1.2"/><path d="M124 239.6 q.8 -1 0 -2 q-.8 1 0 2 Z" fill="#fffbe8"/>
      <path d="M124 226 v19 M113 235.5 h22 M180 226 v19 M169 235.5 h22" stroke="#5e2a1f" stroke-width="1.5"/>
      <path d="M111 245 h26 v2.5 h-26 Z M167 245 h26 v2.5 h-26 Z" fill="#4a1f17"/>
      <path d="M111 223 h26 v3.5 h-26 Z M167 223 h26 v3.5 h-26 Z" fill="#f2f6ff"/>
      <path d="M110.5 247 q13 -3 27 0 v1.4 h-27 Z M166.5 247 q13 -3 27 0 v1.4 h-27 Z" fill="#f2f6ff"/>
      <rect x="143" y="234" width="18" height="36" rx="1.5" fill="#3e1b14"/>
      <path d="M146 238 h12 v12 h-12 Z M146 253 h12 v13 h-12 Z" fill="none" stroke="#2c120d" stroke-width=".9"/>
      <circle cx="152" cy="242" r="5.5" fill="none" stroke="#2f7d5c" stroke-width="2.8"/><circle cx="152" cy="242" r="5.5" fill="none" stroke="#5fb98a" stroke-width=".7" stroke-dasharray="1.2 2"/><circle cx="152" cy="247" r="1.8" fill="#ff5a66"/>
      <circle cx="157.5" cy="254" r="1.1" fill="#ffd166"/>
      <rect x="140" y="230" width="24" height="3" fill="#2b1f2e"/>
      <circle class="porch" cx="152" cy="228" r="16" fill="url(#xm-warm-halo)"/>
    </g>
    <g class="smoke" filter="url(#xm-smoke-blur)">${smoke}</g>

    <g class="tree">
      <circle cx="${tx}" cy="190" r="92" fill="url(#xm-tree-glow)"/>
      <rect x="${tx - 5.5}" y="256" width="11" height="16" fill="url(#xm-trunk)"/>
      ${tree.body}
      ${tree.lights}
      <circle class="star-halo" cx="${tx}" cy="56" r="26" fill="url(#xm-warm-halo)"/>
      ${star(tx, 56, 13.5, 5.6)}
    </g>

    <path d="M-10 ${FH} L-10 ${n1(groundY(-10))} ${drift} L275 ${FH} Z" fill="url(#xm-snow-front)"/>
    <path d="M-10 ${n1(groundY(-10))} ${drift}" fill="none" stroke="#ffffff" stroke-width="1.8" opacity=".9"/>
    <g fill="#3c4886" filter="url(#xm-soft4)"><ellipse cx="104" cy="275" rx="52" ry="5.5" opacity=".42"/><path d="M200 271 L250 273 L256 288 L204 286 Z" opacity=".38"/></g>
    <path d="${trail}" fill="#97a5d8" opacity=".5" filter="url(#xm-soft)"/>
    <g fill="#7f8cc4" opacity=".5">${steps}</g>
    <g filter="url(#xm-soft)" fill="url(#xm-spill)" opacity=".55"><path d="M113 271 L135 271 L143 294 L103 294 Z"/><path d="M169 273 L191 273 L201 296 L161 296 Z"/><path d="M143 272 L161 272 L168 300 L136 300 Z"/></g>
    <ellipse class="pool" cx="140" cy="${n1(groundY(140) + 18)}" rx="110" ry="24" fill="url(#xm-warm-pool)" opacity=".4"/>
    <ellipse class="pool" cx="${tx}" cy="${n1(groundY(tx) + 12)}" rx="70" ry="16" fill="url(#xm-warm-pool)" opacity=".35"/>
    ${gift(43, 274, 15, 12, "#2fa59a", "#f4f7ff")}
    ${gift(90, 276, 20, 15, "#d23a48", "#ffd166")}
    ${gift(111, 278, 12, 9, "#f0b43c", "#d23a48")}
    ${lantern(126, 293)}
    ${lantern(150, 333)}
    <g fill="#ffffff">${snowGlints}</g>
    <path d="M-10 ${FH} L-10 338 C 30 330, 80 332, 120 342 C 160 352, 210 346, 275 339 L275 ${FH} Z" fill="url(#xm-drift)"/>
    <path d="M-10 338 C 30 330, 80 332, 120 342 C 160 352, 210 346, 275 339" fill="none" stroke="#ffffff" stroke-width="1.4" opacity=".9"/>
    <path d="M20 346 C 50 341, 80 344, 104 352 M150 356 C 180 352, 210 351, 240 348" fill="none" stroke="#9aa6dc" stroke-width="2.4" opacity=".35" stroke-linecap="round" filter="url(#xm-soft)"/>
    <g fill="none" stroke="#6b5a74" stroke-width=".9" stroke-linecap="round" opacity=".8">
      <path d="M8 335 q-1 -9 -4 -15 M10 334.6 q1 -10 5 -14 M12.4 334.4 q0 -6 2 -9 M6 335.2 q-3 -5 -6.6 -7"/>
      <path d="M232 344 q1 -8 -1 -13 M234.4 343.6 q2 -7 6 -10 M229.6 344.2 q-2 -5 -5 -6.4"/>
    </g>
    <g fill="#f4f7ff"><ellipse cx="4.2" cy="320.6" rx="1.6" ry=".9"/><ellipse cx="15" cy="320.8" rx="1.5" ry=".8"/><ellipse cx="240" cy="334" rx="1.5" ry=".8"/></g>

    <g class="hare">
      <ellipse cx="22" cy="317" rx="1.8" ry="1" fill="#8d9ad0" opacity=".5"/><ellipse cx="14" cy="321" rx="1.8" ry="1" fill="#8d9ad0" opacity=".45"/><ellipse cx="6" cy="318" rx="1.8" ry="1" fill="#8d9ad0" opacity=".4"/>
      <ellipse cx="42" cy="313.5" rx="12" ry="2.4" fill="#3c4886" opacity=".5" filter="url(#xm-soft)"/>
      <ellipse cx="38" cy="306" rx="8.5" ry="6.6" fill="url(#xm-hare)"/>
      <ellipse cx="34.5" cy="308.5" rx="5.6" ry="4.6" fill="url(#xm-hare)"/>
      <circle cx="30" cy="305.5" r="2.5" fill="#f4f6ff"/>
      <g class="ears">
        <ellipse cx="43.2" cy="291.6" rx="1.7" ry="5.2" transform="rotate(-14 43.2 296)" fill="#a99fbd"/>
        <ellipse cx="46.2" cy="291.2" rx="1.8" ry="5.4" transform="rotate(10 46.2 296)" fill="#c4bbd6"/>
        <ellipse cx="46.3" cy="291.6" rx=".8" ry="3.8" transform="rotate(10 46.2 296)" fill="#e7aab8"/>
      </g>
      <ellipse cx="45.6" cy="299.4" rx="4.8" ry="4.1" fill="url(#xm-hare)"/>
      <circle cx="47.6" cy="298.6" r=".95" fill="#1b1a26"/><circle cx="47.9" cy="298.3" r=".3" fill="#ffffff"/>
      <circle cx="50.2" cy="300" r=".65" fill="#e98a9a"/>
      <ellipse cx="45.2" cy="311.6" rx="2.6" ry="1.3" fill="#d9d3e6"/>
    </g>

    <g class="snowman">
      <ellipse cx="226" cy="303" rx="28" ry="5" fill="#3c4886" opacity=".5" filter="url(#xm-soft)"/>
      <circle cx="214" cy="286" r="17" fill="url(#xm-snowman)"/>
      <ellipse cx="215.5" cy="272" rx="10" ry="2.6" fill="#8e9ad0" opacity=".55" filter="url(#xm-soft)"/>
      <circle cx="214" cy="261" r="12.5" fill="url(#xm-snowman)"/>
      <ellipse cx="215" cy="251.5" rx="7" ry="2" fill="#8e9ad0" opacity=".5" filter="url(#xm-soft)"/>
      <circle cx="214" cy="242" r="9.5" fill="url(#xm-snowman)"/>
      <path d="M199.6 281 a14.6 14.6 0 0 1 8 -11.6 M203 256 a11 11 0 0 1 5.4 -6.4" fill="none" stroke="#ffffff" stroke-width="1.1" opacity=".8" stroke-linecap="round"/>
      <path d="M203 259 Q195 255 186 248 M191 251.6 Q189 248 188.4 244 M195.4 254.6 Q193 257 190 257.6" fill="none" stroke="#5a3520" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M202.4 250 q11.6 6 23.2 0 l.4 4.6 q-12 6.4 -24 0 Z" fill="#d23a48"/>
      <path d="M203 252.2 q11 5.6 22.4 0" fill="none" stroke="#f2f6ff" stroke-width=".9" stroke-dasharray="2 2.4" opacity=".75"/>
      <path d="M207.6 254.6 q-1.6 7 -3.4 13 l5.6 .8 q.8 -6.4 1.6 -12.6 Z" fill="#b52a39"/>
      <path d="M204.2 267.6 l.4 2 M206 268 l.3 2 M207.8 268.3 l.2 2" stroke="#d23a48" stroke-width=".8"/>
      <circle cx="209.2" cy="255" r="2.4" fill="#c22f40"/>
      <ellipse cx="214" cy="233.4" rx="12" ry="2.6" fill="#15151d"/>
      <path d="M206.6 233 L207.6 218.6 Q214 217.4 220.4 218.6 L221.4 233 Z" fill="url(#xm-hat)"/>
      <ellipse cx="214" cy="218.6" rx="6.4" ry="1.4" fill="#2c2c3e"/>
      <path d="M206.8 228.6 Q214 230 221.2 228.6 L221.4 231.6 Q214 233 206.6 231.6 Z" fill="#d23a48"/>
      <path d="M218 229.6 q3 -3.6 5.6 -1.6 q-2 2.8 -5.6 1.6 Z M218 229.6 q-.6 -4 2 -5.2 q1 3 -2 5.2 Z" fill="#2f7d5c"/>
      <circle cx="217.6" cy="230" r="1" fill="#e23d4f"/><circle cx="219.2" cy="230.8" r=".9" fill="#e23d4f"/>
      <path d="M201.6 234.6 Q214 236.6 226.4 234.6" fill="none" stroke="#f4f7ff" stroke-width="1.4" stroke-linecap="round"/>
      <g class="eyes"><circle cx="210.4" cy="240.2" r="1.45" fill="url(#xm-coal)"/><circle cx="217.6" cy="240.2" r="1.45" fill="url(#xm-coal)"/><circle cx="210" cy="239.7" r=".4" fill="#ffffff"/><circle cx="217.2" cy="239.7" r=".4" fill="#ffffff"/></g>
      <path d="M214.4 242.6 L227 244.8 L214.4 246.4 Z" fill="url(#xm-carrot)"/>
      <path d="M217.4 243.4 l.4 2.4 M220.6 244 l.3 1.6" stroke="#b44a12" stroke-width=".5"/>
      <g fill="url(#xm-coal)"><circle cx="209.2" cy="246.6" r=".75"/><circle cx="211.4" cy="247.9" r=".75"/><circle cx="214" cy="248.4" r=".75"/><circle cx="216.6" cy="247.9" r=".75"/><circle cx="218.8" cy="246.6" r=".75"/>
        <circle cx="214" cy="260" r="1.5"/><circle cx="214" cy="266.4" r="1.5"/><circle cx="214" cy="281" r="1.6"/></g>
      <g class="arm"><path d="M225 258.6 Q233 255 242 249 M237.4 252 Q239.6 248.6 240 244.6 M232.4 255.2 Q235 256.6 238 256.4" fill="none" stroke="#5a3520" stroke-width="1.8" stroke-linecap="round"/></g>
    </g>
  </svg>`;
}

/**
 * The string of lights hung across the top of the window, W x 64: a wire that
 * sags a little between hooks, with a bulb every ~26 px. The bulbs end above
 * y = 48, so they hang in the gap under the tab bar and leave the pane
 * headers clear.
 */
export function garland(W: number): string {
  const hooks: number[] = [];
  const span = W / Math.max(3, Math.round(W / 230));
  for (let x = 0; x <= W + 1; x += span) hooks.push(x);
  const pts: Pt[] = [];
  for (let i = 0; i < hooks.length - 1; i++) {
    const a = hooks[i], b = hooks[i + 1], sag = 4 + (b - a) * 0.01;
    for (let k = i ? 1 : 0; k <= 24; k++) {
      const f = k / 24;
      pts.push([a + (b - a) * f, 31 + Math.sin(f * Math.PI) * sag]);
    }
  }
  const wire = "M" + pts.map(([x, y]) => `${n1(x)} ${n1(y)}`).join(" L");
  // Bulbs at even spacing along the wire.
  const colors = ["#ff4d5e", "#ffc24a", "#5aa8ff", "#4fe08f"];
  let bulbs = "";
  let acc = 0, next = 13, n = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const seg = Math.hypot(x1 - x0, y1 - y0);
    while (acc + seg >= next) {
      const f = (next - acc) / seg, x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f;
      const c = colors[n % 4], tilt = (Math.sin(n * 1.7) * 14).toFixed(1);
      bulbs += `<g transform="translate(${n1(x)} ${n1(y)}) rotate(${tilt})"><rect x="-2" y="-.8" width="4" height="3.2" rx=".8" fill="#2c3048"/><ellipse class="g-bulb" style="--c:${c};animation-delay:${(-(n * 0.37) % 3.2).toFixed(2)}s" cx="0" cy="6.2" rx="3.2" ry="4.4" fill="${c}"/><ellipse cx="-1" cy="4.8" rx=".8" ry="1.3" fill="#ffffff" opacity=".7"/></g>`;
      next += 26;
      n++;
    }
    acc += seg;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="64" viewBox="0 0 ${W} 64"><path d="${wire}" fill="none" stroke="#1b1e30" stroke-width="2"/><path d="${wire}" fill="none" stroke="#3a3f5e" stroke-width=".8" transform="translate(0 -.6)"/>${bulbs}</svg>`;
}

type Pt = [number, number];

/** Builds the whole scene for a W x H window. Same input, same output. */
export function buildScene(W: number, H: number): Scene {
  const rnd = mulberry32(2024);
  return {
    layers: [
      { name: "sky", svg: sky(W, H, rnd) },
      { name: "aurora", svg: aurora(W, H) },
      ...landscape(W, H, rnd),
    ],
    fore: foreground(rnd),
  };
}
