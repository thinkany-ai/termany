import { useRef, useState, type ReactNode } from "react";
import { crest, groundAt, hillShape, seeded, useReaction, useReducedMotion, useSay, useStill, type Hill } from "./kit";

export const NEAR: Hill = {
  start: [0, 232],
  curves: [
    [40, 224, 90, 226, 130, 229],
    [170, 232, 210, 225, 240, 227],
  ],
};

// ---------------------------------------------------------------------------
// Tombstones. Each stands with its foot 4 units below the crest (local y -4 is
// ground). Clicking one raises its ghost, who says one of its lines.

type Stone = {
  name: string;
  x: number;
  tilt: number;
  /** Outline, drawn at the stone's foot. */
  shape: string;
  /** Extra shapes drawn in stone (a cross's ring). */
  extra?: ReactNode;
  /** Lettering: text, baseline, size. */
  lines: [string, number, number][];
  /** Highest point, including anything sitting on it, in local units. */
  top: number;
  says: string[];
  crack?: string;
};

const STONES: Stone[] = [
  {
    name: "ie6",
    x: 24,
    tilt: -5,
    shape: "M-13 8V-18A13 13 0 0 1 13-18V8Z",
    lines: [["RIP", -21.4, 7.4], ["IE6", -12, 7]],
    top: -31,
    says: ["best viewed in IE6", "please upgrade me"],
    crack: "M9.2-23.4l-1.4 3 1.2 1.8-1.6 3.4.8 2.2",
  },
  {
    name: "jquery",
    x: 62,
    tilt: 2,
    shape: "M-11 8V-24Q0-42 11-24V8Z",
    lines: [["jQuery", -19.2, 5.4], ["2006–", -11.6, 4.8]],
    top: -52,
    says: ["$(ghost).fadeIn()", "I was the framework"],
  },
  {
    name: "flash",
    x: 99,
    tilt: -3,
    shape: "M-10 8V-15H-3V-30H-10.5V-35.5H-3V-43H3V-35.5H10.5V-30H3V-15H10V8Z",
    extra: <circle cy="-32.8" r="6.6" fill="none" stroke="url(#hs-stone)" strokeWidth="2.2" />,
    lines: [["Flash", -8.4, 5.2]],
    top: -43,
    says: ["install Flash Player", "skip intro ▸"],
  },
  {
    name: "todo",
    x: 134,
    tilt: 7,
    shape: "M-12 8V-13L-8.5-17.5H8.5L12-13V8Z",
    lines: [["TODO", -8.6, 6.4]],
    top: -18,
    says: ["fix later (2009)", "still not done"],
  },
];

const footOf = (s: Stone) => groundAt(NEAR, s.x) + 4;
const ghostY = (s: Stone) => footOf(s) + s.top - 12;

const GHOST_MS = 3800;

/** What the still (README) pose shows: the jQuery ghost mid-sentence. */
export const STILL_LINE = (() => {
  const s = STONES[1];
  return { x: s.x, y: ghostY(s) - 21, text: s.says[0], ms: GHOST_MS };
})();

function Tombstone({ stone, onClick }: { stone: Stone; onClick: () => void }) {
  return (
    <g transform={`translate(${stone.x} ${footOf(stone).toFixed(2)}) rotate(${stone.tilt})`}>
      <g className="hs-stone hs-hit" onClick={onClick}>
        <path d={stone.shape} fill="url(#hs-stone)" />
        {stone.extra}
        <path d={stone.shape} fill="#fff" filter="url(#hs-stone-tex)" opacity=".75" />
        <path d={stone.shape} fill="none" stroke="#b9a6dc" strokeOpacity=".38" strokeWidth=".6" />
        {stone.lines.map(([text, y, size]) => (
          <g key={text} fontSize={size} textAnchor="middle" className="hs-epitaph">
            <text y={y + 0.5} fill="#a691c4" opacity=".5">
              {text}
            </text>
            <text y={y} fill="#1c1428">
              {text}
            </text>
          </g>
        ))}
        {stone.crack && <path d={stone.crack} stroke="#211830" strokeWidth=".6" fill="none" strokeLinejoin="round" />}
        <path d="M-12-6c1.8-2.6 5-3.4 7.6-2 1.4.8 1.2 2.2.2 2.4ZM11.4-5.6c-1.6-1.8-4.2-2.2-6-1-.8.6-.6 1.4.4 1.4Z" fill="#46703a" opacity=".85" />
        <path d="M-10-6.8c.6-.4 1.2-.4 1.6 0M-7-7.4c.4-.3.9-.3 1.2 0" stroke="#7ab05a" strokeWidth=".4" strokeOpacity=".7" fill="none" />
      </g>
      {stone.name === "jquery" && <Cat />}
      {stone.name === "flash" && <Ivy />}
    </g>
  );
}

function Ivy() {
  const leaf = (x: number, y: number, r: number) =>
    `M${x} ${y}c${-1.2 * r} ${-0.4 * r} ${-1.6 * r} ${-1.6 * r} ${-0.6 * r} ${-2 * r}c${0.4 * r} ${0.4 * r} ${0.6 * r} ${0.4 * r} ${0.6 * r} ${0.4 * r}s${0.2 * r} 0 ${0.6 * r} ${-0.4 * r}c${r} ${0.4 * r} ${0.6 * r} ${1.6 * r} ${-0.6 * r} ${2 * r}Z`;
  return (
    <g>
      <path d="M-2.6-15C-1-19-3.4-23-1.4-28S2-33 1.4-39" fill="none" stroke="#2c4a22" strokeWidth=".6" />
      <path d={[leaf(-2.4, -16, 1.2), leaf(-1.4, -21, 1.1), leaf(-2.6, -26, 1.2), leaf(1.6, -31, 1), leaf(0.2, -37, 1.1)].join("")} fill="#3f6a32" />
    </g>
  );
}

// ---------------------------------------------------------------------------
// The ghost. It rises out of the grave behind the stone, hovers and talks,
// then sinks back. SMIL ripples its hem; the rest is CSS.

const HEM_A = "M-9 6C-9-7-7-18 0-18 7-18 9-7 9 6C7 3.8 5.4 8.2 3 6 1 3.8-1 8.2-3 6-5.4 3.8-7 8.2-9 6Z";
const HEM_B = "M-9 6C-9-7-7-18 0-18 7-18 9-7 9 6C7 8.2 5.4 3.8 3 6 1 8.2-1 3.8-3 6-5.4 8.2-7 3.8-9 6Z";

function Ghost({ stone, run, still }: { stone: Stone; run: number; still: boolean }) {
  const reduced = useReducedMotion();
  return (
    <g transform={`translate(${stone.x} ${ghostY(stone).toFixed(2)})`}>
      <g key={run} className={`hs-ghost${still ? " still" : ""}`}>
        <ellipse cy="-5" rx="17" ry="20" fill="url(#hs-ghost-glow)" />
        <g className="hs-ghost-arms">
          <path d="M-8.4-4.6c-3.2.2-4.8 2.2-5.4 4.4 1.8-1.2 3.6-1.6 5.6-1.4Z" fill="url(#hs-ghost)" />
          <path d="M8.4-4.6c3.2.2 4.8 2.2 5.4 4.4-1.8-1.2-3.6-1.6-5.6-1.4Z" fill="url(#hs-ghost)" />
        </g>
        <path d={HEM_A} fill="url(#hs-ghost)">
          {!reduced && !still && <animate attributeName="d" values={`${HEM_A};${HEM_B};${HEM_A}`} dur="1.1s" repeatCount="indefinite" />}
        </path>
        <ellipse cx="-3.4" cy="-13" rx="2.6" ry="1.4" fill="#fff" opacity=".6" />
        <ellipse cx="-3" cy="-8.4" rx="1.55" ry="2.1" fill="#1a1024" />
        <ellipse cx="3" cy="-8.4" rx="1.55" ry="2.1" fill="#1a1024" />
        <circle cx="-2.5" cy="-9.2" r=".45" fill="#fff" />
        <circle cx="3.5" cy="-9.2" r=".45" fill="#fff" />
        <ellipse cy="-3.4" rx="1.5" ry="1.9" fill="#1a1024" className="hs-ghost-mouth" />
        <ellipse cx="-5.4" cy="-5" rx="1.4" ry=".75" fill="#ffadc6" opacity=".55" />
        <ellipse cx="5.4" cy="-5" rx="1.4" ry=".75" fill="#ffadc6" opacity=".55" />
      </g>
    </g>
  );
}

// ---------------------------------------------------------------------------
// The black cat on the jQuery stone. Its tail swishes; it blinks.

function Cat() {
  return (
    <g transform="translate(0 -32.4)" className="hs-cat">
      <defs>
        <radialGradient id="hs-cat-eye">
          <stop offset="0" stopColor="#f4ffb0" />
          <stop offset="1" stopColor="#a8e030" />
        </radialGradient>
      </defs>
      <g className="hs-cat-tail">
        <path d="M3.6-.8C8.4-1.4 10 3.6 8.2 8.6 7.8 9.6 6.8 9.6 7 8.6 8.6 4.4 7.6.6 3.6 1Z" fill="#06030a" />
      </g>
      <path d="M-4.8 0C-6-4-5-8.2-3-10.2-2-11 2-11 3-10.2 5-8.2 6-4 4.8 0Z" fill="#06030a" />
      <path d="M-1.6-1.2C-2.4-.4-2.8 0-3.6 0H-.8ZM1.6-1.2C2.4-.4 2.8 0 3.6 0H.8Z" fill="#17101f" />
      <ellipse cy="-12.6" rx="3.9" ry="3.3" fill="#06030a" />
      <path d="M-3.7-13.6L-3.6-18.2-1-15.3ZM3.7-13.6L3.6-18.2 1-15.3Z" fill="#06030a" />
      <path d="M-3-14.6l-.1-2 1.1 1.3ZM3-14.6l.1-2-1.1 1.3Z" fill="#3a1a2e" />
      <path d="M3.6-18.2L3.7-13.6M3.9-12.6a3.9 3.3 0 0 1-1.6 2.8M3-10.2C5-8.2 6-4 4.8 0" className="hs-rim" strokeOpacity=".55" />
      <g className="hs-cat-eyes">
        <ellipse cx="-1.45" cy="-12.8" rx="1.05" ry=".85" fill="url(#hs-cat-eye)" />
        <ellipse cx="1.45" cy="-12.8" rx="1.05" ry=".85" fill="url(#hs-cat-eye)" />
        <rect x="-1.58" y="-13.6" width=".26" height="1.6" rx=".13" fill="#06030a" />
        <rect x="1.32" y="-13.6" width=".26" height="1.6" rx=".13" fill="#06030a" />
      </g>
      <path d="M-2.4-11.4l-3.4-.4M-2.4-11l-3.2.6M2.4-11.4l3.4-.4M2.4-11l3.2.6" stroke="#8a7aa6" strokeWidth=".18" strokeOpacity=".7" />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Candles in front of the IE6 grave and glowing mushrooms by the Flash cross.

function Candle({ x, h }: { x: number; h: number }) {
  const y = groundAt(NEAR, x) + 1.2;
  return (
    <g>
      <circle cx={x} cy={y - h - 2} r="9" fill="url(#hs-candle-glow)" className="hs-flicker" />
      <rect x={x - 1.3} y={y - h} width="2.6" height={h} rx=".5" fill="url(#hs-wax)" />
      <path d={`M${x - 1.3} ${y - h + 0.4}h2.6v.8c-.3 0-.4 1.4-.7 1.4s-.3-.8-.6-.8-.3 2-.7 2-.3-1.6-.6-1.6Z`} fill="#fbf2df" />
      <path d={`M${x} ${y - h}v-1`} stroke="#2a1a10" strokeWidth=".35" />
      <g transform={`translate(${x} ${y - h - 0.8})`}>
        <path className="hs-flame" d="M0-4.4C1.4-2.4 1.6-.6 0 0-1.6-.6-1.4-2.4 0-4.4Z" fill="url(#hs-flame)" />
      </g>
    </g>
  );
}

function Mushroom({ x, y, s, tilt }: { x: number; y: number; s: number; tilt: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${tilt}) scale(${s})`}>
      <path d="M-.9 0C-1-1.6-.8-3.2-.5-4.4H.5C.8-3.2 1-1.6.9 0Z" fill="#cfeee6" opacity=".85" />
      <path d="M-3.6-4.2C-3.4-7 -1.8-8.4 0-8.4S3.4-7 3.6-4.2C2-4.8-2-4.8-3.6-4.2Z" fill="url(#hs-shroom)" />
      <circle cx="-1.3" cy="-6.6" r=".5" fill="#eafff8" opacity=".8" />
      <circle cx="1.2" cy="-7.2" r=".38" fill="#eafff8" opacity=".8" />
      <circle cx="2.2" cy="-5.6" r=".3" fill="#eafff8" opacity=".7" />
    </g>
  );
}

function Shrooms({ x }: { x: number }) {
  const y = groundAt(NEAR, x) + 1;
  return (
    <g>
      <ellipse cx={x} cy={y - 4} rx="13" ry="9" fill="url(#hs-shroom-glow)" className="hs-shroom-glow" />
      <Mushroom x={x - 3} y={y} s={1.05} tilt={-8} />
      <Mushroom x={x + 2.6} y={y + 0.4} s={0.75} tilt={10} />
      <Mushroom x={x + 5.6} y={y + 0.6} s={0.5} tilt={4} />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Grass along the near crest.

const GRASS = (() => {
  const rand = seeded(5);
  let d = "";
  for (let x = 1; x < 240; x += 1.6 + rand() * 2.2) {
    const y = groundAt(NEAR, x) + 0.8;
    const h = 1.4 + rand() ** 1.6 * 4.6;
    const lean = (rand() - 0.5) * 2.6;
    d += `M${(x - 0.6).toFixed(2)} ${y.toFixed(2)}Q${(x + lean * 0.3).toFixed(2)} ${(y - h * 0.6).toFixed(2)} ${(x + lean).toFixed(2)} ${(y - h).toFixed(2)}Q${(x + 0.2).toFixed(2)} ${(y - h * 0.45).toFixed(2)} ${(x + 0.6).toFixed(2)} ${y.toFixed(2)}Z`;
  }
  return d;
})();

// ---------------------------------------------------------------------------

export function Graveyard() {
  const still = useStill();
  const say = useSay();
  const [run, rise] = useReaction(GHOST_MS);
  const [haunted, setHaunted] = useState(still ? 1 : -1);
  const said = useRef(STONES.map(() => 0));

  const raise = (i: number) => {
    const s = STONES[i];
    setHaunted(i);
    rise();
    say(s.x, ghostY(s) - 21, s.says[said.current[i]++ % s.says.length], GHOST_MS);
  };
  const ghost = still ? STONES[1] : run && haunted >= 0 ? STONES[haunted] : null;

  return (
    <g>
      <defs>
        <linearGradient id="hs-stone" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8e7caa" />
          <stop offset=".45" stopColor="#52446a" />
          <stop offset="1" stopColor="#272036" />
        </linearGradient>
        <filter id="hs-stone-tex" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="1.3 .8" numOctaves="3" seed="9" />
          <feColorMatrix values="0 0 0 0 .12  0 0 0 0 .08  0 0 0 0 .18  0 0 0 -1.5 .95" />
          <feComposite in2="SourceGraphic" operator="in" />
        </filter>
        <linearGradient id="hs-ghost" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".97" />
          <stop offset=".65" stopColor="#f0e8ff" stopOpacity=".9" />
          <stop offset="1" stopColor="#cbb8ff" stopOpacity=".35" />
        </linearGradient>
        <radialGradient id="hs-ghost-glow">
          <stop offset="0" stopColor="#e6dbff" stopOpacity=".4" />
          <stop offset="1" stopColor="#e6dbff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="hs-trail-near" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2c1f3e" />
          <stop offset="1" stopColor="#1a1226" stopOpacity=".6" />
        </linearGradient>
        <linearGradient id="hs-near" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#140c1f" />
          <stop offset="1" stopColor="#08050d" />
        </linearGradient>
        <linearGradient id="hs-wax" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#c9b28e" />
          <stop offset=".5" stopColor="#f6ead2" />
          <stop offset="1" stopColor="#b59a74" />
        </linearGradient>
        <radialGradient id="hs-candle-glow">
          <stop offset="0" stopColor="#ffbe5a" stopOpacity=".45" />
          <stop offset="1" stopColor="#ffbe5a" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="hs-shroom" cx=".45" cy=".3" r=".8">
          <stop offset="0" stopColor="#d6fff4" />
          <stop offset=".45" stopColor="#5af0cc" />
          <stop offset="1" stopColor="#13806e" />
        </radialGradient>
        <radialGradient id="hs-shroom-glow">
          <stop offset="0" stopColor="#4ff0c8" stopOpacity=".38" />
          <stop offset="1" stopColor="#4ff0c8" stopOpacity="0" />
        </radialGradient>
      </defs>

      {ghost && <Ghost stone={ghost} run={run} still={still} />}
      {STONES.map((s, i) => (
        <Tombstone key={s.name} stone={s} onClick={() => raise(i)} />
      ))}
      <path d={hillShape(NEAR)} fill="url(#hs-near)" />
      <path d="M74.6 230.4C76.6 230 85 230 88 230.6 92 240 96 250 102 260H58C64 250 70 240 74.6 230.4Z" fill="url(#hs-trail-near)" />
      <path d={crest(NEAR)} className="hs-rim" strokeOpacity=".22" />
      <path d={GRASS} fill="#100a19" />
      <Candle x={7} h={6.4} />
      <Candle x={11.4} h={4.4} />
      <Candle x={41} h={5.4} />
      <Shrooms x={117} />
      <Shrooms x={236} />
    </g>
  );
}
