import { css, H, seeded, useEvery, useReaction, useReducedMotion, useStill, W } from "./kit";

export const MOON = { x: 176, y: 64, r: 30 };

// ---------------------------------------------------------------------------
// Sky: a gradient that is transparent at the top (it meets the sidebar), a
// violet nebula, a magenta glow on the horizon, stars and shooting stars.

const STARS = (() => {
  const rand = seeded(11);
  const tints = ["#fff4dc", "#fff4dc", "#ffe1ee", "#dbe6ff"];
  const out: { x: number; y: number; r: number; fill: string; dur: number; delay: number }[] = [];
  while (out.length < 54) {
    const x = rand() * W;
    const y = rand() * 150;
    const r = 0.22 + rand() ** 2.2 * 0.85;
    const fill = tints[Math.floor(rand() * tints.length)];
    const dur = 2.6 + rand() * 4;
    const delay = -rand() * 6;
    if (Math.hypot(x - MOON.x, y - MOON.y) < MOON.r + 14) continue;
    out.push({ x, y, r, fill, dur, delay });
  }
  return out;
})();

const SPARKLES: [number, number, number][] = [
  [70, 20, 1.1],
  [122, 30, 0.8],
  [26, 44, 0.75],
  [228, 120, 0.6],
];
const SPARKLE = "M0-3.6C.3-1 1-.3 3.6 0 1 .3.3 1 0 3.6-.3 1-1 .3-3.6 0-1-.3-.3-1 0-3.6Z";

export function Sky() {
  return (
    <g>
      <defs>
        <linearGradient id="hs-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#150f1c" stopOpacity="0" />
          <stop offset=".16" stopColor="#170f25" stopOpacity=".85" />
          <stop offset=".42" stopColor="#1f1534" />
          <stop offset=".62" stopColor="#2c1c45" />
          <stop offset=".75" stopColor="#3b2250" />
        </linearGradient>
        <radialGradient id="hs-nebula">
          <stop offset="0" stopColor="#6a45a8" stopOpacity=".26" />
          <stop offset=".6" stopColor="#4a2f80" stopOpacity=".08" />
          <stop offset="1" stopColor="#4a2f80" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="hs-horizon">
          <stop offset="0" stopColor="#8a3a7a" stopOpacity=".42" />
          <stop offset=".55" stopColor="#5a2a6a" stopOpacity=".14" />
          <stop offset="1" stopColor="#5a2a6a" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="hs-sparkle-glow">
          <stop offset="0" stopColor="#fff2d8" stopOpacity=".55" />
          <stop offset="1" stopColor="#fff2d8" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="hs-shoot-tail" gradientUnits="userSpaceOnUse" x1="-26" y1="0" x2="0" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#fff" stopOpacity=".9" />
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill="url(#hs-sky)" />
      <ellipse cx="118" cy="48" rx="130" ry="34" fill="url(#hs-nebula)" transform="rotate(-14 118 48)" />
      <ellipse cx="40" cy="110" rx="80" ry="26" fill="url(#hs-nebula)" opacity=".7" />
      <ellipse cx="128" cy="168" rx="170" ry="46" fill="url(#hs-horizon)" />
      {STARS.map((s, i) => (
        <circle
          key={i}
          className={i % 4 === 0 ? "hs-star" : undefined}
          cx={s.x.toFixed(1)}
          cy={s.y.toFixed(1)}
          r={s.r.toFixed(2)}
          fill={s.fill}
          style={{ animationDuration: `${s.dur.toFixed(1)}s`, animationDelay: `${s.delay.toFixed(1)}s` }}
        />
      ))}
      {SPARKLES.map(([x, y, s], i) => (
        <g key={i} transform={`translate(${x} ${y}) scale(${s})`}>
          <circle r="6" fill="url(#hs-sparkle-glow)" className="hs-sparkle-glow" style={{ animationDelay: `${-i * 1.9}s` }} />
          <path className="hs-sparkle" d={SPARKLE} style={{ animationDelay: `${-i * 1.9}s` }} />
        </g>
      ))}
      <ShootingStar x={34} y={16} angle={22} duration={19} delay={-6} />
      <ShootingStar x={96} y={10} angle={30} duration={31} delay={-21} />
    </g>
  );
}

function ShootingStar({ x, y, angle, duration, delay }: { x: number; y: number; angle: number; duration: number; delay: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${angle})`}>
      <g className="hs-shoot" style={{ animationDuration: `${duration}s`, animationDelay: `${delay}s` }}>
        <path d="M-26 0L0-.45V.45Z" fill="url(#hs-shoot-tail)" />
        <circle r=".75" fill="#fff" />
      </g>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Moon: halo, body, maria, surface texture, craters with lit rims, and limb
// darkening. Every so often a witch crosses its face.

const CRATERS: [number, number, number][] = [
  [165, 55, 5.4],
  [187, 73, 4],
  [182, 47, 2.6],
  [166, 76, 3.1],
  [194, 58, 2],
  [175, 64, 1.5],
  [158, 66, 1.7],
  [190, 85, 1.6],
];

function Crater({ x, y, r }: { x: number; y: number; r: number }) {
  // The far wall catches the light: a bright arc on the lower right.
  const a = `M${(x - r * 0.8).toFixed(2)} ${(y + r * 0.6).toFixed(2)}A${r} ${r} 0 0 0 ${(x + r * 0.92).toFixed(2)} ${(y - r * 0.4).toFixed(2)}`;
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill="url(#hs-crater)" />
      <path d={a} fill="none" stroke="#fff6dc" strokeOpacity=".7" strokeWidth={Math.max(r * 0.16, 0.3)} strokeLinecap="round" />
    </g>
  );
}

export function Moon() {
  const reduced = useReducedMotion();
  const still = useStill();
  const [flight, fly] = useReaction(WITCH_MS);
  useEvery(fly, 95_000, 28_000, !reduced && !still);
  const { x, y, r } = MOON;
  return (
    <g>
      <defs>
        <radialGradient id="hs-halo-wide">
          <stop offset=".18" stopColor="#ffd9a0" stopOpacity=".24" />
          <stop offset=".42" stopColor="#ff9e6a" stopOpacity=".08" />
          <stop offset="1" stopColor="#ff9e6a" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="hs-halo-near">
          <stop offset=".66" stopColor="#ffeac2" stopOpacity=".55" />
          <stop offset=".8" stopColor="#ffd89a" stopOpacity=".16" />
          <stop offset="1" stopColor="#ffd89a" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="hs-moon" cx=".38" cy=".34" r=".78">
          <stop offset="0" stopColor="#fffaf0" />
          <stop offset=".45" stopColor="#fbe6bb" />
          <stop offset=".85" stopColor="#ecc286" />
          <stop offset="1" stopColor="#d9a466" />
        </radialGradient>
        <radialGradient id="hs-moon-limb" cx=".42" cy=".38" r=".7">
          <stop offset=".72" stopColor="#7a3f62" stopOpacity="0" />
          <stop offset="1" stopColor="#7a3f62" stopOpacity=".42" />
        </radialGradient>
        <radialGradient id="hs-crater" cx=".42" cy=".4">
          <stop offset="0" stopColor="#c58a4e" stopOpacity=".8" />
          <stop offset=".75" stopColor="#d9a466" stopOpacity=".5" />
          <stop offset="1" stopColor="#e8bd80" stopOpacity=".15" />
        </radialGradient>
        <clipPath id="hs-moon-clip">
          <circle cx={x} cy={y} r={r} />
        </clipPath>
        <filter id="hs-moon-tex" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency=".32" numOctaves="4" seed="4" />
          <feColorMatrix values="0 0 0 0 .62  0 0 0 0 .4  0 0 0 0 .24  0 0 0 1.6 -.62" />
        </filter>
      </defs>
      <circle cx={x} cy={y} r="118" fill="url(#hs-halo-wide)" />
      <circle cx={x} cy={y} r={r * 1.5} fill="url(#hs-halo-near)" />
      <g>
        <circle cx={x} cy={y} r={r} fill="url(#hs-moon)" />
        <g clipPath="url(#hs-moon-clip)">
          <rect x={x - r} y={y - r} width={r * 2} height={r * 2} filter="url(#hs-moon-tex)" opacity=".55" />
          <g fill="#c79158" opacity=".34">
            <path d="M155 57c3-9 15-12 21-6 6 5 2 13-6 14-8 2-17-1-15-8Z" />
            <path d="M178 75c6-4 15-1 16 6 0 6-8 10-15 7-6-3-7-10-1-13Z" />
            <path d="M170 41c4-4 11-3 13 2 1 4-4 7-9 6-5-1-6-5-4-8Z" />
            <path d="M188 52c3-2 7-1 7 2s-3 5-6 4-3-4-1-6Z" />
          </g>
          {CRATERS.map(([cx, cy, cr], i) => (
            <Crater key={i} x={cx} y={cy} r={cr} />
          ))}
        </g>
        <circle cx={x} cy={y} r={r} fill="url(#hs-moon-limb)" />
      </g>
      {(flight > 0 || still) && <Witch key={flight} still={still} />}
    </g>
  );
}

// ---------------------------------------------------------------------------
// The witch: a silhouette on a broom with a cat riding behind, crossing the
// moon left to right on a shallow arc.

export const WITCH_MS = 4600;

function Witch({ still }: { still: boolean }) {
  return (
    <g className={`hs-witch${still ? " still" : ""}`}>
      <g className="hs-witch-bob" transform="scale(.82)">
        <g fill="#07040b">
          {/* Bristles fan out behind. */}
          <path d="M-13.5 1.6C-16 .4-19 -.6-22.5-.4-20.4.6-19.4 1.4-18.6 2.2-20.6 2.4-22.2 3.4-23.4 4.8-20 4.6-17 4.2-13.3 3.2Z" />
          <path d="M-14.2 .8-13.2 3.6-12.2 3.4-13 .7Z" fill="#2a1a12" />
          {/* Broomstick. */}
          <path d="M-13 1.9L13.5-1.4 13.7-.6-12.8 2.9Z" />
          {/* Cape streaming back. */}
          <path d="M-1.2-6.2C-5.6-7.6-9.4-6.8-13.4-9.8-11.6-6.2-9.8-3.6-6.4-1.4-4.6-.6-2.6-.4-.6-.8Z" />
          {/* Body, arm to the broom, legs. */}
          <path d="M-2.4.8L-.8-7.6H2.4L3.6.4Z" />
          <path d="M1.8-5.6L7.2-.8 6.4 0 1-4.2Z" />
          <path d="M-.6.6L2.6 3.2 6 3 6.2 3.8 2.2 4.2-1.4 1.6Z" />
          {/* Head, nose, hair, hat. */}
          <circle cx="1" cy="-9.6" r="2.2" />
          <path d="M2.8-9.8L5.4-9 2.9-8.5Z" />
          <path d="M-.8-10.4C-3.4-10.6-5.6-9.4-7.6-10.6-6.2-8.6-4-7.8-1.2-8.4Z" />
          <path d="M-4.4-11.2L7.2-12.4 7-11.2-4.2-10.2Z" />
          <path d="M-1.4-11.6C-.4-15 .2-18 3.8-21.8 3.4-19 3.6-15.2 4.4-12Z" />
          {/* The cat on the back of the broom. */}
          <path d="M-10.6 1.8C-11 0-10.2-1.4-9-1.8L-9.4-3.4-8.2-2.4-7.2-2.6-6.8-3.6-6.4-2.2C-6-1.2-6.4.6-7.4 1.4Z" />
          <path d="M-10.4 1C-12.4.6-13.4-1-13.4-2.8-12.6-1.6-11.8-1-10.4-.8Z" />
        </g>
        <circle cx="-8.4" cy="-1.4" r=".32" fill="#d8ff6a" />
        <circle cx="-7.3" cy="-1.5" r=".32" fill="#d8ff6a" />
      </g>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Clouds: soft puffs with a moonlit upper edge. Radial gradients make the
// soft edges, so a moving cloud costs no blur filter.

const CLOUD_PUFFS: [number, number, number, number][] = [
  [0, 0, 30, 5.2],
  [-14, -2.4, 14, 5.6],
  [5, -4.6, 16, 7],
  [21, -1.4, 12, 4.4],
  [-26, .6, 10, 3.2],
];

/** A cloud drifting left to right across the whole sky; `delay` sets where
 *  it is when the scene appears. */
export function Cloud({ y, scale, duration, delay, opacity = 1 }: { y: number; scale: number; duration: number; delay: number; opacity?: number }) {
  return (
    <g transform={`translate(0 ${y}) scale(${scale})`} opacity={opacity}>
      <g className="hs-cloud" style={{ animationDuration: `${duration}s`, animationDelay: `${delay}s` }}>
        {CLOUD_PUFFS.map(([cx, cy, rx, ry], i) => (
          <ellipse key={i} cx={cx} cy={cy} rx={rx} ry={ry} fill="url(#hs-puff)" />
        ))}
        {CLOUD_PUFFS.map(([cx, cy, rx, ry], i) => (
          <ellipse key={`l${i}`} cx={cx + 2} cy={cy - ry * 0.45} rx={rx * 0.8} ry={ry * 0.55} fill="url(#hs-puff-lit)" />
        ))}
      </g>
    </g>
  );
}

export function CloudDefs() {
  return (
    <defs>
      <radialGradient id="hs-puff">
        <stop offset="0" stopColor="#3a2858" stopOpacity=".92" />
        <stop offset=".55" stopColor="#30214b" stopOpacity=".7" />
        <stop offset="1" stopColor="#30214b" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="hs-puff-lit">
        <stop offset="0" stopColor="#9d86c8" stopOpacity=".42" />
        <stop offset="1" stopColor="#9d86c8" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

// ---------------------------------------------------------------------------
// Bats, with membrane wings and finger bones.

const BAT_WING = "M1.3-1.5C3.8-4.6 8.4-6.2 12.4-4.4 11.2-2.9 10.9-1.3 11.4.6 9.8-.4 8.3-.2 7.4 1.3 6.3.1 4.6.1 3.5 1.3 3 .2 2.2-.5 1.3-.2Z";
const BAT_BONES = "M1.6-1.2L12.2-4.3M5.6-3.6L7.4 1.2M8.6-4.5L11.3.5";

function BatBody() {
  return (
    <>
      <g className="hs-wing-l">
        <g transform="scale(-1 1)">
          <path d={BAT_WING} />
          <path d={BAT_BONES} className="hs-bat-bones" />
        </g>
      </g>
      <g className="hs-wing-r">
        <path d={BAT_WING} />
        <path d={BAT_BONES} className="hs-bat-bones" />
      </g>
      <ellipse cy=".2" rx="2.3" ry="3.4" />
      <circle cy="-3.1" r="2" />
      <path d="M-1.8-4.2l-.6-2.7 1.7 1.5ZM1.8-4.2l.6-2.7-1.7 1.5Z" />
      <circle className="hs-bat-eye" cx="-.72" cy="-3.2" r=".4" />
      <circle className="hs-bat-eye" cx=".72" cy="-3.2" r=".4" />
    </>
  );
}

export function Bat({ x, y, scale, duration, delay }: { x: number; y: number; scale: number; duration: number; delay: number }) {
  return (
    <g className="hs-bat-fly" style={css({ "--hs-rest": `${x}px`, animationDuration: `${duration}s`, animationDelay: `${delay}s` })}>
      <g transform={`translate(0 ${y}) scale(${scale})`}>
        <g className="hs-bat-bob" style={{ animationDelay: `${delay / 3}s` }}>
          <g className="hs-bat">
            <BatBody />
          </g>
        </g>
      </g>
    </g>
  );
}
