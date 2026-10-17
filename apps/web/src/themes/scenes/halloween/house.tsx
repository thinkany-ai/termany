import { groundAt, hillShape, crest, type Hill } from "./kit";

// ---------------------------------------------------------------------------
// The far ridge: low contrast and a little lighter than everything in front of
// it (atmospheric perspective), with a row of pines on its crest.

export const RIDGE: Hill = {
  start: [0, 156],
  curves: [
    [20, 149, 40, 145, 62, 149],
    [82, 153, 98, 141, 118, 139],
    [142, 136, 160, 149, 186, 147],
    [206, 145, 222, 137, 240, 141],
  ],
};

/** A pine of stacked tiers, `h` tall, standing at (x, y). */
function pine(x: number, y: number, h: number) {
  const tiers = 4;
  let d = `M${x - 0.35} ${y}V${y - h * 0.18}`;
  for (let i = 0; i < tiers; i++) {
    const top = y - h * (0.18 + (0.82 * (i + 1)) / tiers);
    const bottom = y - h * (0.12 + (0.82 * i) / tiers);
    const half = (h * 0.34 * (tiers - i)) / tiers;
    d += `M${x - half} ${bottom}L${x} ${top}L${x + half} ${bottom}Z`;
  }
  return `${d}M${x - 0.35} ${y}h.7V${y - h * 0.2}h-.7Z`;
}

const PINES: [number, number][] = [
  [118, 9], [124, 12], [129, 8], [134, 11], [140, 7], [150, 9], [156, 6],
  [196, 8], [202, 11], [207, 7], [214, 10], [220, 13], [226, 9], [232, 11], [238, 8],
];

export function Ridge() {
  return (
    <g>
      <defs>
        <linearGradient id="hs-ridge" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a2756" />
          <stop offset=".25" stopColor="#2a1b40" />
        </linearGradient>
        <linearGradient id="hs-haze" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4a2f68" stopOpacity="0" />
          <stop offset=".5" stopColor="#4a2f68" stopOpacity=".35" />
          <stop offset="1" stopColor="#4a2f68" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={hillShape(RIDGE)} fill="url(#hs-ridge)" />
      <path d={PINES.map(([x, h]) => pine(x, groundAt(RIDGE, x) + 1.5, h)).join("")} fill="#271a3b" />
      <path d={crest(RIDGE)} className="hs-rim" strokeOpacity=".22" />
      <rect y="146" width="240" height="34" fill="url(#hs-haze)" />
    </g>
  );
}

// ---------------------------------------------------------------------------
// The haunted house: a Victorian with a spired tower, a mansard roof with
// dormers and iron cresting, a porch, and a side wing. The moon is to the
// right, so the right-facing edges carry a cool rim light. Its windows burn
// and flicker; smoke curls from the chimney.

const HOUSE_HILL =
  "M0 179C16 174 40 172 70 172 96 172 116 177 138 190L138 260H0Z";

/** Iron cresting along the roof ridge. */
const CRESTING = Array.from({ length: 11 }, (_, i) => {
  const x = 38 + i * 4.2;
  return `M${x - 0.3} 98V95.4L${x} 94.2 ${x + 0.3} 95.4V98Z`;
}).join("");

/** Porch balusters, skipping the steps. */
const BALUSTERS = Array.from({ length: 28 }, (_, i) => 32 + i * 2.1)
  .filter((x) => x < 54 || x > 66)
  .map((x) => `M${x.toFixed(1)} 163.4h.5V170h-.5Z`)
  .join("");

function LitWindow({ x, y, w, h, arch = false, curtains = true }: { x: number; y: number; w: number; h: number; arch?: boolean; curtains?: boolean }) {
  const shape = arch
    ? `M${x} ${y + h}V${y + w / 2}a${w / 2} ${w / 2} 0 0 1 ${w} 0V${y + h}Z`
    : `M${x} ${y}h${w}v${h}h${-w}Z`;
  return (
    <g>
      <path d={shape} fill="url(#hs-window)" />
      {curtains && (
        <path
          d={`M${x} ${y + (arch ? w / 2 - 1 : 0)}h${w * 0.3}q${-w * 0.1} ${h * 0.5} ${-w * 0.08} ${h * (arch ? 0.62 : 0.9)}H${x}Z` +
            `M${x + w} ${y + (arch ? w / 2 - 1 : 0)}h${-w * 0.3}q${w * 0.1} ${h * 0.5} ${w * 0.08} ${h * (arch ? 0.62 : 0.9)}H${x + w}Z`}
          fill="#c4561a"
          opacity=".75"
        />
      )}
      <path d={`M${x + w / 2} ${y}v${h}M${x} ${y + h * 0.48}h${w}`} stroke="#1a0f22" strokeWidth=".55" />
      <path d={`M${x - 0.7} ${y + h}h${w + 1.4}v1h${-w - 1.4}Z`} fill="#2c1e3c" />
    </g>
  );
}

function Windows() {
  return (
    <>
      <LitWindow x={24.5} y={110} w={6} h={10} arch />
      <LitWindow x={38.5} y={122} w={7} h={10} />
      <LitWindow x={52} y={122} w={7} h={10} />
      <LitWindow x={66} y={122} w={7} h={10} />
      <LitWindow x={43.2} y={104.6} w={4.6} h={6.4} curtains={false} />
      <LitWindow x={38} y={153.5} w={8} h={8} />
      <LitWindow x={73} y={153.5} w={8} h={8} />
      <LitWindow x={89} y={143} w={8} h={10} />
      <circle cx="93" cy="128.4" r="2.3" fill="url(#hs-window)" />
    </>
  );
}

export function House() {
  return (
    <g>
      <defs>
        <linearGradient id="hs-house" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1e1330" />
          <stop offset="1" stopColor="#120a1b" />
        </linearGradient>
        <pattern id="hs-shingle" width="3" height="2.4" patternUnits="userSpaceOnUse">
          <rect width="3" height="2.4" fill="#1b1129" />
          <path d="M0 2.4a1.5 1.3 0 0 1 3 0" fill="none" stroke="#2f2044" strokeWidth=".35" />
        </pattern>
        <linearGradient id="hs-window" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe9a8" />
          <stop offset=".6" stopColor="#ffb547" />
          <stop offset="1" stopColor="#f07a1e" />
        </linearGradient>
        <radialGradient id="hs-window-glow">
          <stop offset="0" stopColor="#ffb547" stopOpacity=".5" />
          <stop offset="1" stopColor="#ffb547" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="hs-spill">
          <stop offset="0" stopColor="#ff9d3a" stopOpacity=".32" />
          <stop offset="1" stopColor="#ff9d3a" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="hs-smoke">
          <stop offset="0" stopColor="#a594c4" stopOpacity=".38" />
          <stop offset="1" stopColor="#a594c4" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="hs-door" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4a2c16" />
          <stop offset="1" stopColor="#2a170b" />
        </linearGradient>
      </defs>

      {/* Smoke rises behind the chimney cap. */}
      <g className="hs-smoke">
        {[0, 1, 2].map((i) => (
          <ellipse key={i} cx="77" cy="82" rx="5" ry="4" fill="url(#hs-smoke)" style={{ animationDelay: `${-i * 2.3}s` }} />
        ))}
      </g>

      <g fill="url(#hs-house)">
        {/* Chimney. */}
        <rect x="74" y="84" width="6" height="16" />
        <rect x="73" y="82.4" width="8" height="2" />
        {/* Tower: shaft, flared spire, finial and weathervane. */}
        <rect x="18" y="100" width="18" height="76" />
        <path d="M14.5 102.4L18 99.6 27 58 36 99.6 39.5 102.4Z" fill="url(#hs-shingle)" />
        <rect x="17.4" y="99.6" width="19.2" height="2.4" fill="#22162f" />
        {/* Main block, mansard roof, cresting. */}
        <rect x="34" y="116" width="50" height="60" />
        <path d="M31 118.4L36 98H82L87 118.4Z" fill="url(#hs-shingle)" />
        <rect x="30.4" y="117.6" width="57.2" height="1.6" fill="#22162f" />
        <path d={CRESTING} fill="#120a1b" />
        {/* Dormers. */}
        <path d="M41 116V105.6L45.5 100.4 50 105.6V116Z" />
        <path d="M39.6 106.2L45.5 99.2 51.4 106.2 50.6 106.8 45.5 100.8 40.4 106.8Z" fill="#22162f" />
        <path d="M65 116V105.6L69.5 100.4 74 105.6V116Z" />
        <path d="M63.6 106.2L69.5 99.2 75.4 106.2 74.6 106.8 69.5 100.8 64.4 106.8Z" fill="#22162f" />
        {/* Side wing with its gable. */}
        <rect x="84" y="132" width="18" height="44" />
        <path d="M81 134.4L93 121 105 134.4Z" fill="url(#hs-shingle)" />
      </g>

      {/* Window glow: soft pools behind the panes, then the panes. */}
      <g className="hs-windows">
        {[
          [27.5, 115, 9],
          [42, 127, 9],
          [55.5, 127, 9],
          [69.5, 127, 9],
          [42, 157.5, 9],
          [77, 157.5, 9],
          [93, 148, 9],
          [93, 128.4, 6],
        ].map(([cx, cy, r], i) => (
          <circle key={i} cx={cx} cy={cy} r={r} fill="url(#hs-window-glow)" />
        ))}
        <Windows />
        {/* A figure stands at one window. */}
        <path d="M54.2 132v-4.6c0-1.2.6-2 1.3-2.2-.6-.4-.9-1-.9-1.6 0-1 .7-1.7 1.4-1.7s1.4.7 1.4 1.7c0 .6-.3 1.2-.9 1.6.7.2 1.3 1 1.3 2.2V132Z" fill="#3a1a12" opacity=".85" />
      </g>
      {/* The right dormer is dark. */}
      <rect x="67.2" y="104.6" width="4.6" height="6.4" fill="#0b0612" />
      {/* Boarded tower window. */}
      <rect x="24.5" y="134" width="6" height="9" fill="#0b0612" />
      <path d="M23.8 136.2l7.4 1.6-.2 1-7.4-1.6ZM23.8 140.4l7.4-1.4.2 1-7.4 1.4Z" fill="#4b3222" />
      {/* A shutter hangs from one hinge. */}
      <rect x="73.6" y="121.6" width="3" height="10.6" fill="#24172f" transform="rotate(16 73.6 121.6)" />

      {/* Porch: roof, columns, railing, door, steps. */}
      <path d="M30.5 146.4H87.5L90 151H28Z" fill="#1d1229" />
      <path d="M30.5 146.4H87.5L90 151" fill="none" className="hs-rim" />
      <g fill="#170e22">
        {[34, 48.5, 71.5, 86].map((x) => (
          <rect key={x} x={x - 0.8} y="151" width="1.6" height="21" />
        ))}
        <path d="M30 162.4H54V163.4H30ZM66 162.4H90V163.4H66Z" />
        <path d={BALUSTERS} />
      </g>
      <path d="M56.5 172V159.6a3.5 3.5 0 0 1 7 0V172Z" fill="url(#hs-door)" />
      <path d="M58.6 163h2.8v.5h-2.8ZM58.6 167h2.8v.5h-2.8Z" fill="#2a170b" />
      <circle cx="62.2" cy="166" r=".45" fill="#e0a648" />
      <path d="M54 172h12v1.4H54ZM52.6 173.4h14.8v1.4H52.6ZM51.2 174.8h17.6v1.4H51.2Z" fill="#26192f" />

      {/* Moonlight on the right-facing edges. */}
      <path
        d="M27 58L36 99.6 39.5 102.4M36 102.4V176M82 98L87 118.4M84 118.4V132M93 121L105 134.4M102 134.4V176M80 84V100M50 105.6L45.5 100.4M74 105.6L69.5 100.4"
        className="hs-rim"
      />

      {/* Weathervane. */}
      <path d="M27 58V48.6" stroke="#120a1b" strokeWidth=".7" />
      <circle cx="27" cy="52.6" r=".9" fill="#120a1b" />
      <path className="hs-vane" d="M22.4 49.6H31.6M31.6 49.6l-1.8-1.2M31.6 49.6l-1.8 1.2M22.4 49.6l-1.1-1.4M22.4 49.6l-1.1 1.4" stroke="#120a1b" strokeWidth=".45" fill="none" />

      <path d={HOUSE_HILL} fill="url(#hs-house-hill)" />
      <defs>
        <linearGradient id="hs-house-hill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#24183a" />
          <stop offset=".3" stopColor="#1a1129" />
        </linearGradient>
      </defs>
      <path d="M57.6 176.2H62.4C66 182 72 188 78.6 194H76.4C69 188 62 182 57.6 176.2Z" fill="#33244a" opacity=".85" />
      <path d="M0 179C16 174 40 172 70 172 96 172 116 177 138 190" className="hs-rim" />
      <ellipse cx="60" cy="176.5" rx="36" ry="5" fill="url(#hs-spill)" className="hs-spill" />
    </g>
  );
}
