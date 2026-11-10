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

/**
 * The foreground vignette. Moonlight comes from the upper left, so shadows
 * fall to the right; the windows, porch, path lamps and tree light the snow.
 */
function foreground(rnd: () => number): string {
  const { w: FW, h: FH } = FORE;
  const tx = 62; // tree centre
  const lights: [number, number, string][] = [];
  const garland = (a: [number, number], b: [number, number], c: [number, number], n: number) => {
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * b[0] + t * t * c[0];
      const y = (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * b[1] + t * t * c[1];
      lights.push([x, y, ["#ff5a66", "#ffd166", "#6fb6ff", "#8ef0b4"][lights.length % 4]]);
    }
    return `<path d="M${n1(a[0])} ${n1(a[1])} Q${n1(b[0])} ${n1(b[1])} ${n1(c[0])} ${n1(c[1])}" fill="none" stroke="#e8c46a" stroke-width=".8" opacity=".55"/>`;
  };
  // One tier: a wide triangle whose lower edge droops in five scallops.
  const tier = (top: number, bot: number, hw: number) => {
    let d = `M${tx} ${top} L${tx + hw} ${bot}`;
    for (let i = 5; i > 0; i--) {
      const x1 = tx - hw + (2 * hw * (i - 1)) / 5, xm = tx - hw + (2 * hw * (i - 0.5)) / 5;
      d += ` Q${n1(xm)} ${n1(bot + 7)} ${n1(x1)} ${bot}`;
    }
    return d + " Z";
  };
  // Snow clumps on the moonlit (left) side of the drooping edge.
  const snowLip = (bot: number, hw: number, seed: number) => {
    const r = mulberry32(seed);
    let out = "";
    for (let i = 0; i < 3; i++) {
      const x0 = tx - hw + (2 * hw * i) / 5, x1 = tx - hw + (2 * hw * (i + 1)) / 5, xm = (x0 + x1) / 2;
      const w = (x1 - x0) * (0.32 + r() * 0.14) * (1 - i * 0.18);
      out += `<ellipse cx="${n1(xm - 1)}" cy="${n1(bot + 1.5)}" rx="${n1(w)}" ry="${n1(2.4 + r())}" fill="#f2f6ff"/>`;
      if (r() < 0.6) out += `<ellipse cx="${n1(xm + w * 0.6)}" cy="${n1(bot - 1)}" rx="${n1(w * 0.45)}" ry="1.8" fill="#dfe7fb"/>`;
    }
    return out;
  };
  const tiers: [number, number, number][] = [[176, 262, 58], [140, 214, 48], [108, 172, 38], [82, 134, 27], [66, 98, 16]];
  let tree = "", garlands = "";
  const baubles: [number, number, string][] = [];
  tiers.forEach(([t, b, hw], i) => {
    const mid = t + (b - t) * 0.62, w2 = hw * 0.58;
    const boughs = `<path d="M${n1(tx - w2)} ${n1(mid)} Q${n1(tx - w2 * 0.5)} ${n1(mid + 5)} ${tx} ${n1(mid + 1)} Q${n1(tx + w2 * 0.5)} ${n1(mid + 6)} ${n1(tx + w2)} ${n1(mid + 1)}" fill="none" stroke="#0f2e24" stroke-width="2" opacity=".45" stroke-linecap="round"/>`;
    tree += `<path d="${tier(t, b, hw)}" fill="url(#xm-pine)"/><path d="${tier(t, b, hw)}" fill="url(#xm-pine-shade)"/>${i < 4 ? boughs : ""}${snowLip(b, hw, 40 + i)}`;
    if (i < 4) {
      for (let k = 0; k < 3 - Math.floor(i / 2); k++) {
        const f = [0.3, 0.62, 0.46][k];
        baubles.push([tx - hw * 0.8 + hw * 1.6 * f, t + (b - t) * (0.72 + (k % 2) * 0.12), ["#e23d4f", "#f2c14e", "#c9d4f2", "#5aa7e6"][(i + k) % 4]]);
      }
    }
    garlands += garland([tx - hw * 0.82, b - (b - t) * 0.18], [tx - hw * 0.1, b + 6], [tx + hw * 0.86, b - (b - t) * 0.42], [10, 8, 6, 4, 2][i]);
  });
  const groundY = (x: number) => 266 + x * 0.05;
  const drift = `C 50 ${n1(groundY(50) - 4)}, 120 ${n1(groundY(120) + 6)}, 180 ${n1(groundY(180))} C 220 ${n1(groundY(220) - 4)}, 245 ${n1(groundY(245))}, 260 ${n1(groundY(260) + 2)}`;
  let steps = "";
  for (let i = 0; i < 7; i++) steps += `<ellipse cx="${160 - i * 9 + (i % 2 ? 4 : -4)}" cy="${282 + i * 11}" rx="3.2" ry="1.6" fill="#8d9ad0" opacity=".55"/>`;
  const pathLamps = ([[176, 279], [128, 300], [176, 322]] as const).map(([x, y]) =>
    `<g class="pathlamp"><circle cx="${x}" cy="${y}" r="14" fill="url(#xm-warm-halo)" opacity=".75"/><rect x="${x - 2.5}" y="${y - 4}" width="5" height="6" rx="1" fill="#ffd27a"/><path d="M${x - 3.2} ${y - 4} h6.4 l-1.6 -2 h-3.2 Z" fill="#2b1f2e"/><path d="M${x - 1} ${y + 2} h2 v6 h-2 Z" fill="#2b1f2e"/></g>`,
  ).join("");
  let snowGlints = "";
  for (let i = 0; i < 30; i++) snowGlints += `<circle${i < 8 ? twinkle(rnd) : ""} cx="${n1(rnd() * FW)}" cy="${n1(groundY(120) + 10 + rnd() * 75)}" r="${(0.6 + rnd() * 0.8).toFixed(2)}"/>`;
  const logs = Array.from({ length: 8 }, (_, i) => `<line x1="104" x2="200" y1="${n1(220 + i * 6.5)}" y2="${n1(220 + i * 6.5)}"/>`).join("");
  const smoke = [0, 1, 2, 3, 4].map((i) => `<circle cx="189" cy="140" r="${6 + i}" fill="#b4bbe0" style="animation-delay:${-i * 1.4}s"/>`).join("");
  const baubleSvg = baubles.map(([x, y, c]) =>
    `<circle cx="${n1(x)}" cy="${n1(y)}" r="3.4" fill="${c}"/><circle cx="${n1(x - 1.1)}" cy="${n1(y - 1.2)}" r="1" fill="#ffffff" opacity=".85"/><rect x="${n1(x - 1)}" y="${n1(y - 4.6)}" width="2" height="1.6" fill="#c8a24a"/>`,
  ).join("");
  const bulbs = lights.map(([x, y, c], i) =>
    `<circle class="bulb" style="--c:${c};animation-delay:${(-(i * 0.53) % 2.6).toFixed(2)}s" cx="${n1(x)}" cy="${n1(y)}" r="2.3" fill="${c}"/>`,
  ).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${FW}" height="${FH}" viewBox="0 0 ${FW} ${FH}">
    <defs>
      <linearGradient id="xm-pine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3a8a66"/><stop offset=".45" stop-color="#22604a"/><stop offset="1" stop-color="#123528"/></linearGradient>
      <linearGradient id="xm-pine-shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset=".7" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#0a1830" stop-opacity=".45"/></linearGradient>
      <linearGradient id="xm-snow-front" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6f8ff"/><stop offset=".3" stop-color="#d9e0f7"/><stop offset="1" stop-color="#8794c9"/></linearGradient>
      <linearGradient id="xm-snow-back" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c0c9ee"/><stop offset="1" stop-color="#6c79b4"/></linearGradient>
      <linearGradient id="xm-wall" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#9a4e36"/><stop offset="1" stop-color="#5e2a1f"/></linearGradient>
      <linearGradient id="xm-side-wall" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4f2219"/><stop offset="1" stop-color="#3a1913"/></linearGradient>
      <linearGradient id="xm-roof-snow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#c9d3f2"/></linearGradient>
      <radialGradient id="xm-warm-pool"><stop offset="0" stop-color="#ffb35c" stop-opacity=".8"/><stop offset=".45" stop-color="#ff9a40" stop-opacity=".28"/><stop offset="1" stop-color="#ff9a40" stop-opacity="0"/></radialGradient>
      <radialGradient id="xm-warm-halo"><stop offset="0" stop-color="#fff0b8" stop-opacity="1"/><stop offset=".22" stop-color="#ffcf6a" stop-opacity=".55"/><stop offset="1" stop-color="#ffb24a" stop-opacity="0"/></radialGradient>
      <radialGradient id="xm-tree-glow"><stop offset="0" stop-color="#ffcf7a" stop-opacity=".35"/><stop offset="1" stop-color="#ffcf7a" stop-opacity="0"/></radialGradient>
      <radialGradient id="xm-snowman" cx=".32" cy=".3"><stop offset="0" stop-color="#ffffff"/><stop offset=".65" stop-color="#e6ecfb"/><stop offset="1" stop-color="#9eaad8"/></radialGradient>
      <radialGradient id="xm-hare" cx=".35" cy=".3"><stop offset="0" stop-color="#e4def0"/><stop offset=".7" stop-color="#b3a9c8"/><stop offset="1" stop-color="#7f7699"/></radialGradient>
      <filter id="xm-smoke-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.2"/></filter>
      <linearGradient id="xm-window" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff1b0"/><stop offset="1" stop-color="#ffb24a"/></linearGradient>
    </defs>

    <path d="M-10 ${FH} L-10 214 C 50 196, 140 196, 260 222 L260 ${FH} Z" fill="url(#xm-snow-back)" opacity=".7"/>
    <path d="${pine(118, 222, 64) + pine(140, 218, 50) + pine(230, 226, 72) + pine(208, 222, 46) + pine(14, 214, 54)}" fill="#14234a"/>

    <g class="cabin">
      <path d="M200 222 L238 210 L238 262 L200 270 Z" fill="url(#xm-side-wall)"/>
      <path d="M196 220 L242 206 L250 212 L200 228 Z" fill="#2b1f2e"/>
      <path d="M194 218 L242 203 L252 210 C 250 216 246 214 244 212 L200 226 Z" fill="url(#xm-roof-snow)"/>
      <rect x="182" y="150" width="14" height="34" fill="#4b3a48"/><rect x="179" y="145" width="20" height="8" rx="3.5" fill="#f2f6ff"/>
      <path d="M104 214 L152 172 L200 214 L200 270 L104 270 Z" fill="url(#xm-wall)"/>
      <g stroke="#4a1f17" stroke-width="1" opacity=".5">${logs}</g>
      <path d="M90 216 L152 162 L214 216 L206 221 L152 173 L98 221 Z" fill="#2b1f2e"/>
      <path d="M86 216 L152 157 L218 216 C 215 225 208 222 205 218 L152 170 L99 218 C 95 224 89 224 86 216 Z" fill="url(#xm-roof-snow)"/>
      <path d="M92 222 l2 9 l2 -9 M104 212 l1.6 6 l1.6 -6 M118 199 l1.4 5 l1.4 -5 M190 205 l1.4 6 l1.4 -6 M208 222 l2 10 l2 -10" fill="#e6eeff"/>
      <circle class="window" cx="152" cy="192" r="7.5" fill="url(#xm-window)"/><path d="M152 184.5 v15 M144.5 192 h15" stroke="#5e2a1f" stroke-width="1.3"/>
      <g class="window"><rect x="113" y="226" width="22" height="19" rx="1.5" fill="url(#xm-window)"/><rect x="169" y="226" width="22" height="19" rx="1.5" fill="url(#xm-window)"/></g>
      <path d="M113 226 h5 l-2 19 h-3 Z M135 226 h-5 l2 19 h3 Z M169 226 h5 l-2 19 h-3 Z M191 226 h-5 l2 19 h3 Z" fill="#b8402e" opacity=".85"/>
      <path d="M182 244 l-4 0 l4 -11 l4 11 Z" fill="#7a3a12" opacity=".75"/><circle cx="182" cy="232.5" r="1.1" fill="#fff6cc"/>
      <path d="M124 226 v19 M113 235.5 h22 M180 226 v19 M169 235.5 h22" stroke="#5e2a1f" stroke-width="1.5"/>
      <path d="M111 223 h26 v3.5 h-26 Z M167 223 h26 v3.5 h-26 Z" fill="#f2f6ff"/>
      <rect x="143" y="234" width="18" height="36" rx="1.5" fill="#3e1b14"/>
      <circle cx="152" cy="242" r="5.5" fill="none" stroke="#2f7d5c" stroke-width="2.8"/><circle cx="152" cy="247" r="1.8" fill="#ff5a66"/>
      <circle cx="157.5" cy="254" r="1.1" fill="#ffd166"/>
      <rect x="140" y="230" width="24" height="3" fill="#2b1f2e"/>
      <circle class="porch" cx="152" cy="228" r="16" fill="url(#xm-warm-halo)"/>
    </g>
    <g class="smoke" filter="url(#xm-smoke-blur)">${smoke}</g>
    <path d="M200 270 L250 272 L250 286 L196 284 Z" fill="#4a5590" opacity=".35"/>
    <ellipse cx="96" cy="272" rx="46" ry="7" fill="#4a5590" opacity=".35"/>

    <g class="tree">
      <circle cx="${tx}" cy="190" r="90" fill="url(#xm-tree-glow)"/>
      <rect x="${tx - 6}" y="258" width="12" height="14" fill="#4a2a1c"/>
      ${tree}
      ${garlands}
      ${baubleSvg}
      <circle class="star-halo" cx="${tx}" cy="62" r="26" fill="url(#xm-warm-halo)"/>
      <path d="M${tx} 50 L${tx + 3.6} 59 L${tx + 12.5} 59.5 L${tx + 5.6} 65.3 L${tx + 8} 74.3 L${tx} 69.2 L${tx - 8} 74.3 L${tx - 5.6} 65.3 L${tx - 12.5} 59.5 L${tx - 3.6} 59 Z" fill="#ffd166" stroke="#fff6cc" stroke-width=".9"/>
    </g>
    <g>
      <rect x="88" y="262" width="20" height="16" rx="1.5" fill="#d23a48"/><rect x="96.5" y="262" width="3" height="16" fill="#ffd166"/><rect x="88" y="268" width="20" height="3" fill="#ffd166"/><path d="M98 262 q-6 -7 -7 0 M98 262 q6 -7 7 0" stroke="#ffd166" stroke-width="1.6" fill="none"/>
      <rect x="20" y="266" width="16" height="13" rx="1.5" fill="#2fa59a"/><rect x="26.5" y="266" width="3" height="13" fill="#f4f7ff"/><rect x="20" y="271" width="16" height="2.6" fill="#f4f7ff"/>
      <rect x="108" y="270" width="12" height="10" rx="1.2" fill="#f0b43c"/><rect x="113" y="270" width="2.4" height="10" fill="#d23a48"/>
    </g>

    <path d="M-10 ${FH} L-10 ${n1(groundY(-10))} ${drift} L260 ${FH} Z" fill="url(#xm-snow-front)"/>
    <path d="M-10 ${n1(groundY(-10))} ${drift}" fill="none" stroke="#ffffff" stroke-width="1.8" opacity=".9"/>
    <ellipse class="pool" cx="140" cy="${n1(groundY(140) + 18)}" rx="110" ry="24" fill="url(#xm-warm-pool)" opacity=".5"/>
    <ellipse class="pool" cx="${tx}" cy="${n1(groundY(tx) + 12)}" rx="70" ry="16" fill="url(#xm-warm-pool)" opacity=".35"/>
    ${steps}
    ${pathLamps}
    <g fill="#ffffff">${snowGlints}</g>

    <g class="hare">
      <ellipse cx="22" cy="317" rx="1.8" ry="1" fill="#8d9ad0" opacity=".5"/><ellipse cx="14" cy="321" rx="1.8" ry="1" fill="#8d9ad0" opacity=".45"/><ellipse cx="6" cy="318" rx="1.8" ry="1" fill="#8d9ad0" opacity=".4"/>
      <ellipse cx="40" cy="313.5" rx="11" ry="2.2" fill="#4a5590" opacity=".45"/>
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
      <ellipse cx="218" cy="303" rx="22" ry="4.5" fill="#4a5590" opacity=".45"/>
      <circle cx="214" cy="286" r="17" fill="url(#xm-snowman)"/>
      <circle cx="214" cy="261" r="12.5" fill="url(#xm-snowman)"/>
      <circle cx="214" cy="242" r="9.5" fill="url(#xm-snowman)"/>
      <path d="M202 250.5 q12 6.5 24 0 v4.5 q-12 6.5 -24 0 Z" fill="#d23a48"/><path d="M206 254 l-4 14 l5.5 .5 l2.5 -13.5 Z" fill="#b52a39"/>
      <rect x="203" y="231.5" width="22" height="2.8" rx="1" fill="#1b1a26"/><rect x="206.5" y="217" width="15" height="15.5" rx="1.2" fill="#1b1a26"/><rect x="206.5" y="227" width="15" height="2.8" fill="#d23a48"/>
      <path d="M216 222 a3 3 0 1 1 .1 0" fill="#2f7d5c"/>
      <g class="eyes"><circle cx="210.5" cy="240" r="1.4" fill="#1b1a26"/><circle cx="217.5" cy="240" r="1.4" fill="#1b1a26"/></g>
      <path d="M214 243.5 l12 1.8 l-12 2 Z" fill="#ff8a2a"/>
      <path d="M209 247 q5 3 10 0" fill="none" stroke="#1b1a26" stroke-width="1" stroke-dasharray="1 1.6" stroke-linecap="round"/>
      <circle cx="214" cy="259" r="1.4" fill="#1b1a26"/><circle cx="214" cy="266" r="1.4" fill="#1b1a26"/><circle cx="214" cy="281" r="1.5" fill="#1b1a26"/>
      <path d="M202 259 l-16 -10 M190 251.5 l-3 -7" stroke="#5a3520" stroke-width="2" stroke-linecap="round"/>
      <g class="arm"><path d="M226 259 l16 -10 M238 251.5 l2.5 -7" stroke="#5a3520" stroke-width="2" stroke-linecap="round"/></g>
    </g>
    <g>${bulbs}</g>
  </svg>`;
}

/**
 * The string of lights hung across the top of the window, W x 64: a wire that
 * sags between hooks, with a bulb every ~30 px.
 */
export function garland(W: number): string {
  const hooks: number[] = [];
  const span = W / Math.max(3, Math.round(W / 230));
  for (let x = 0; x <= W + 1; x += span) hooks.push(x);
  const pts: Pt[] = [];
  for (let i = 0; i < hooks.length - 1; i++) {
    const a = hooks[i], b = hooks[i + 1], sag = 14 + (b - a) * 0.03;
    for (let k = i ? 1 : 0; k <= 24; k++) {
      const f = k / 24;
      pts.push([a + (b - a) * f, 30 + Math.sin(f * Math.PI) * sag]);
    }
  }
  const wire = "M" + pts.map(([x, y]) => `${n1(x)} ${n1(y)}`).join(" L");
  // Bulbs at even spacing along the wire.
  const colors = ["#ff4d5e", "#ffc24a", "#5aa8ff", "#4fe08f"];
  let bulbs = "";
  let acc = 0, next = 16, n = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const seg = Math.hypot(x1 - x0, y1 - y0);
    while (acc + seg >= next) {
      const f = (next - acc) / seg, x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f;
      const c = colors[n % 4], tilt = (Math.sin(n * 1.7) * 14).toFixed(1);
      bulbs += `<g transform="translate(${n1(x)} ${n1(y)}) rotate(${tilt})"><rect x="-2.5" y="-1" width="5" height="4" rx="1" fill="#2c3048"/><ellipse class="g-bulb" style="--c:${c};animation-delay:${(-(n * 0.37) % 3.2).toFixed(2)}s" cx="0" cy="8" rx="4.2" ry="6" fill="${c}"/></g>`;
      next += 30;
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
