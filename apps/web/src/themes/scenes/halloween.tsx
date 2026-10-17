import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import "./halloween.css";

// A moonlit graveyard for the foot of the sidebar, drawn in one 240×200 SVG
// (the sidebar's default width, so one unit is one CSS pixel). Back to front:
// sky and stars, the moon with drifting clouds, bats, a haunted house on the
// far hill, a fenced middle hill with an owl in a dead tree, three tombstones,
// the near hill, a jack-o'-lantern, and fog.
//
// Most things react to a click: a ghost rises from a tombstone and talks, the
// owl turns its head, the house goes dark and something looks out, the pumpkin
// cackles and throws embers, a bat flees, the spider climbs its thread. Every
// reaction ends by itself; nothing is persisted.

const W = 240;

/**
 * A one-shot reaction. trigger() starts it, and it ends by itself after `ms`.
 * The returned run id changes on every trigger, so an element keyed on it
 * restarts its CSS animation even when clicked again mid-reaction. 0 is idle.
 */
function useReaction(ms: number): [number, () => void] {
  const [run, setRun] = useState(0);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const trigger = useCallback(() => {
    window.clearTimeout(timer.current);
    setRun((r) => r + 1);
    timer.current = window.setTimeout(() => setRun(0), ms);
  }, [ms]);
  return [run, trigger];
}

/** A speech bubble whose tail points at (x, y). It stays inside the scene. */
function Bubble({ x, y, text, ms, still }: { x: number; y: number; text: string; ms: number; still?: boolean }) {
  const w = Math.round(text.length * 4.5 + 12);
  const left = Math.min(Math.max(x - w / 2, 3), W - w - 3);
  return (
    <g className={`hs-bubble${still ? " still" : ""}`} style={{ "--hs-say": `${ms}ms` } as CSSProperties}>
      <rect x={left} y={y - 17} width={w} height={14} rx={7} />
      <path d={`M${x - 3} ${y - 3.5}L${x} ${y + 1}L${x + 3} ${y - 3.5}Z`} />
      <text x={left + w / 2} y={y - 7.2} textAnchor="middle">
        {text}
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Sky

const STARS: [number, number, number][] = [
  [14, 18, 0.8], [38, 8, 0.6], [60, 30, 1], [92, 12, 0.7], [118, 38, 0.5],
  [134, 8, 0.9], [210, 14, 0.7], [229, 38, 0.8], [228, 84, 0.5], [22, 60, 0.6],
  [84, 52, 0.5], [106, 74, 0.4], [48, 84, 0.45], [148, 92, 0.4], [6, 40, 0.5],
];
const SPARKLES: [number, number, number][] = [
  [72, 18, 1],
  [124, 22, 0.8],
  [30, 38, 0.7],
];
const SPARKLE = "M0-3.4L.55-.55 3.4 0 .55.55 0 3.4-.55.55-3.4 0-.55-.55Z";

function Sky() {
  return (
    <g className="hs-sky">
      <rect width={W} height="200" fill="url(#hs-sky)" />
      {STARS.map(([x, y, r], i) => (
        <circle
          key={i}
          className="hs-star"
          cx={x}
          cy={y}
          r={r}
          style={{ animationDelay: `${-(i * 0.73) % 4}s`, animationDuration: `${3 + (i % 4)}s` }}
        />
      ))}
      {SPARKLES.map(([x, y, s], i) => (
        <g key={i} transform={`translate(${x} ${y}) scale(${s})`}>
          <path className="hs-sparkle" d={SPARKLE} style={{ animationDelay: `${-i * 1.7}s` }} />
        </g>
      ))}
    </g>
  );
}

function Moon() {
  return (
    <g>
      <circle cx="176" cy="58" r="74" fill="url(#hs-halo)" />
      <circle cx="176" cy="58" r="28" fill="url(#hs-moon)" />
      {[
        [166, 49, 5.2],
        [186, 66, 3.8],
        [181, 43, 2.4],
        [167, 70, 2.9],
        [192, 52, 1.9],
        [175, 59, 1.4],
      ].map(([x, y, r], i) => (
        <g key={i}>
          <circle cx={x + 0.5} cy={y + 0.6} r={r} fill="#fff1cf" opacity="0.45" />
          <circle cx={x} cy={y} r={r} fill="url(#hs-crater)" />
        </g>
      ))}
      {/* Terminator: the moon's lower right turns away from the light. */}
      <circle cx="176" cy="58" r="28" fill="url(#hs-moon-shade)" />
    </g>
  );
}

function Cloud({ y, scale, duration, delay, tone }: { y: number; scale: number; duration: number; delay: number; tone: string }) {
  return (
    <g transform={`translate(0 ${y}) scale(${scale})`}>
      <g className="hs-cloud" style={{ animationDuration: `${duration}s`, animationDelay: `${delay}s` }}>
        <g fill={tone} filter="url(#hs-soft)">
          <ellipse cx="0" cy="0" rx="30" ry="3.2" />
          <ellipse cx="-9" cy="-2.6" rx="12" ry="4" />
          <ellipse cx="6" cy="-3.6" rx="13" ry="4.8" />
          <ellipse cx="22" cy="-1" rx="10" ry="2.6" />
        </g>
      </g>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Bats and the spider

const BAT_WING = "M1.4-1.6C4-4.4 8.2-5.6 11.6-3.8 10.5-2.3 10.1-.8 10.6.9 9.1 0 7.7.2 6.9 1.6 5.8.5 4.3.5 3.3 1.6 2.9.5 2.2-.4 1.4-.2Z";

function Bat({ x, y, scale, duration, delay }: { x: number; y: number; scale: number; duration: number; delay: number }) {
  const [fled, flee] = useReaction(6000);
  return (
    <g
      className="hs-bat-fly"
      style={{ "--hs-rest": `${x}px`, animationDuration: `${duration}s`, animationDelay: `${delay}s` } as CSSProperties}
    >
      <g transform={`translate(0 ${y}) scale(${scale})`}>
        <g className="hs-bat-bob" style={{ animationDelay: `${delay / 3}s` }}>
          <g className={`hs-bat hs-hit${fled ? " fled" : ""}`} onClick={flee}>
            {/* A generous invisible target: bats are small and moving. */}
            <circle r="13" fill="transparent" />
            <g className="hs-wing-l">
              <path d={BAT_WING} transform="scale(-1 1)" />
            </g>
            <g className="hs-wing-r">
              <path d={BAT_WING} />
            </g>
            <ellipse cy="0.2" rx="2.4" ry="3.4" />
            <circle cy="-3.2" r="2.1" />
            <path d="M-1.9-4.3l-.5-2.6 1.6 1.4ZM1.9-4.3l.5-2.6-1.6 1.4Z" />
            <circle className="hs-bat-eye" cx="-.75" cy="-3.3" r=".42" />
            <circle className="hs-bat-eye" cx=".75" cy="-3.3" r=".42" />
          </g>
        </g>
      </g>
    </g>
  );
}

const SPIDER_LEGS = [
  "M-1.6-.2C-3.6-2.4-5.6-2.4-7-.6",
  "M-1.8.8C-4.2-.4-6.2.2-7.4 2.2",
  "M-1.8 1.8C-4 1.8-5.6 3.2-6.2 5.4",
  "M-1.4 2.8C-3 3.8-3.8 5.6-3.8 7.8",
];

function Spider() {
  const [up, climb] = useReaction(5200);
  return (
    <g transform="translate(112 0)">
      <g className={`hs-spider hs-hit${up ? " up" : ""}`} onClick={climb}>
        <g className="hs-spider-bob">
          <line className="hs-thread" x1="0" y1="-80" x2="0" y2="38" />
          <g transform="translate(0 41)">
            <rect x="-9" y="-6" width="18" height="16" fill="transparent" />
            <g className="hs-spider-legs">
              {SPIDER_LEGS.map((d, i) => (
                <g key={i}>
                  <path d={d} />
                  <path d={d} transform="scale(-1 1)" />
                </g>
              ))}
            </g>
            <ellipse className="hs-spider-body" cy="3.4" rx="2.9" ry="3.5" />
            <circle className="hs-spider-body" cy="-.4" r="1.75" />
            <circle className="hs-spider-eye" cx="-.65" cy="-.6" r=".38" />
            <circle className="hs-spider-eye" cx=".65" cy="-.6" r=".38" />
          </g>
        </g>
      </g>
    </g>
  );
}

// ---------------------------------------------------------------------------
// The haunted house on the far hill

function House() {
  const [peek, haunt] = useReaction(2600);
  return (
    <g className={`hs-house hs-hit${peek ? " peek" : ""}`} onClick={haunt}>
      <g fill="#120b1a">
        {/* Tower with its spire and finial. */}
        <rect x="21" y="93" width="15" height="47" />
        <path d="M18 95L28.5 61 39 95Z" />
        <path d="M28 61V54h1v7Z" />
        <path d="M26.2 56.4h4.6v.9h-4.6Z" />
        {/* Main block, a crooked roof, a leaning chimney. */}
        <rect x="35" y="105" width="40" height="35" />
        <path d="M30 107L52 85.5 55.5 86.5 80 107Z" />
        <rect x="65" y="86" width="5.5" height="14" transform="rotate(7 67.7 93)" />
        <path d="M63.5 86h8.5v2h-8.5Z" transform="rotate(7 67.7 93)" />
        {/* Side wing. */}
        <rect x="74" y="117" width="17" height="23" />
        <path d="M71.5 119L82.5 109 93.5 119Z" />
      </g>
      {/* Lit windows: a blurred copy underneath makes the glow. */}
      <g className="hs-windows">
        <g filter="url(#hs-glow)" opacity="0.9">
          <WindowShapes />
        </g>
        <WindowShapes />
        {/* Mullions. */}
        <g stroke="#120b1a" strokeWidth="0.7">
          <path d="M42.5 113v6M40 116h5M64.5 113v6M62 116h5M28.5 100.5v4.5M81 124v5M79 126.5h4" />
        </g>
      </g>
      <path className="hs-door" d="M51 140v-10a4 4 0 0 1 8 0v10Z" />
      {/* What looks out when the lights go out. */}
      <g className="hs-eyes">
        <g filter="url(#hs-glow)">
          <ellipse cx="27" cy="101.6" rx="1" ry="1.35" />
          <ellipse cx="30" cy="101.6" rx="1" ry="1.35" />
          <ellipse cx="54.3" cy="97.6" rx=".85" ry="1.15" />
          <ellipse cx="56.7" cy="97.6" rx=".85" ry="1.15" />
        </g>
        <g>
          <ellipse cx="27" cy="101.6" rx="1" ry="1.35" />
          <ellipse cx="30" cy="101.6" rx="1" ry="1.35" />
          <ellipse cx="54.3" cy="97.6" rx=".85" ry="1.15" />
          <ellipse cx="56.7" cy="97.6" rx=".85" ry="1.15" />
        </g>
      </g>
    </g>
  );
}

function WindowShapes() {
  return (
    <g fill="url(#hs-window)">
      <path d="M26 105v-5.5a2.5 2.5 0 0 1 5 0V105Z" />
      <circle cx="55.5" cy="97.6" r="2.6" />
      <rect x="40" y="113" width="5" height="6" />
      <rect x="62" y="113" width="5" height="6" />
      <rect x="79" y="124" width="4" height="5" />
    </g>
  );
}

// ---------------------------------------------------------------------------
// The dead tree and its owl

const OWL_MS = 2600;

function Owl() {
  const [hoot, turn] = useReaction(OWL_MS);
  return (
    <g>
      <g className={`hs-owl hs-hit${hoot ? " hoot" : ""}`} onClick={turn}>
        <rect x="192" y="101" width="14" height="18" fill="transparent" />
        <ellipse cx="199" cy="112.5" rx="5.2" ry="6.6" fill="#3b2a4c" />
        <path d="M203.6 109.6a5.2 6.6 0 0 1-1.8 8.6" fill="none" stroke="#9a86b5" strokeOpacity=".55" strokeWidth=".5" />
        <ellipse cx="199" cy="114.5" rx="3.3" ry="4.2" fill="#6a5280" />
        <path d="M197.2 113.4q.9.7 1.8 0M199.6 115.4q.9.7 1.8 0M197.4 117.2q.9.7 1.8 0" stroke="#3b2a4c" strokeWidth=".45" fill="none" />
        <g className="hs-owl-head">
          <path d="M194.2 106.8l-.9-4.2 3 2.4ZM203.8 106.8l.9-4.2-3 2.4Z" fill="#3b2a4c" />
          <ellipse cx="199" cy="107.4" rx="5" ry="3.9" fill="#3b2a4c" />
          <path d="M203.4 105.4a5 3.9 0 0 1 .4 3.4" fill="none" stroke="#9a86b5" strokeOpacity=".55" strokeWidth=".5" />
          <g className="hs-owl-eyes">
            <circle cx="197" cy="107.4" r="2" fill="url(#hs-owl-eye)" />
            <circle cx="201" cy="107.4" r="2" fill="url(#hs-owl-eye)" />
            <circle cx="197.2" cy="107.5" r=".95" fill="#120b1a" />
            <circle cx="201.2" cy="107.5" r=".95" fill="#120b1a" />
            <circle cx="196.7" cy="106.9" r=".35" fill="#fff6d8" />
            <circle cx="200.7" cy="106.9" r=".35" fill="#fff6d8" />
          </g>
          <path d="M198.4 109.2h1.2l-.6 1.3Z" fill="#c98b4a" />
        </g>
        <path d="M196.6 119l-.3 1.2M198 119.2v1.2M200 119.2v1.2M201.4 119l.3 1.2" stroke="#c98b4a" strokeWidth=".5" strokeLinecap="round" />
      </g>
      {hoot > 0 && <Bubble key={hoot} x={199} y={99} text="whooo wrote this?" ms={OWL_MS} />}
    </g>
  );
}

function Tree() {
  return (
    <g fill="#0f0918">
      <path d="M205 176C208.5 164 211 152 209 140 207 129 212 119 216.5 110.5L219.5 111.5C216.5 120 213.4 129 215.4 140 217.5 152 217 164 222 176Z" />
      <path d="M210.5 131C202.5 123 196.5 117 190.5 104.5 189.2 101.6 186.4 99.6 184 100.4 188 101.2 190.2 104.4 191.8 108.4 195.6 116.6 202.4 124.6 209.4 134Z" />
      <path d="M197.5 117.2C193.5 117 189.5 119.2 185.2 118.4 189.2 120.4 193.4 120.6 198.6 119.4Z" />
      <path d="M216.5 114C222.4 108 226.4 101.8 232 92 233 90 235 89 236.2 90 233.2 93.2 230.4 99 228.2 104 225.2 109.4 220.4 114.4 217.6 117.4Z" />
      <path d="M217.4 110.6C218 102.6 216.2 96.4 219 88.4 220.2 92.6 219.6 98.4 220.6 104.4Z" />
      <path d="M228.6 103.4C231.6 103.8 234.6 102.4 237.4 103.6 234.6 104.8 231.8 105.4 228.2 105Z" />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Tombstones and the ghosts behind them

type Stone = {
  x: number;
  y: number;
  tilt: number;
  shape: string;
  lines: [string, number, number][];
  says: string[];
  /** A crack down the stone's face, clear of the lettering. */
  crack?: string;
};

const STONES: Stone[] = [
  {
    x: 34,
    y: 180,
    tilt: -5,
    shape: "M-12.5 10V-16A12.5 12.5 0 0 1 12.5-16V10Z",
    lines: [["RIP", -17.5, 7], ["IE6", -8, 6.4]],
    says: ["best viewed in IE6", "please upgrade me"],
    crack: "M8.6-19.4l-1.4 3 1.2 1.8-1.6 3.2.8 2",
  },
  {
    x: 72,
    y: 177,
    tilt: 2,
    shape: "M-10.5 10V-21Q0-37 10.5-21V10Z",
    lines: [["jQuery", -16, 5.2], ["2006–", -8.5, 4.6]],
    says: ["$(ghost).fadeIn()", "I was the framework"],
  },
  {
    x: 112,
    y: 181,
    tilt: 6,
    shape: "M-12 10V-12.5L-8.5-17H8.5L12-12.5V10Z",
    lines: [["TODO", -8.5, 6.2]],
    says: ["fix later (2009)", "still not done"],
  },
];

const GHOST =
  "M-8.5 6C-8.5-6-6.5-16.5 0-16.5 6.5-16.5 8.5-6 8.5 6L5.7 3.4 2.8 6 0 3.4-2.8 6-5.7 3.4Z";

function Ghost({ stone, run, still }: { stone: Stone; run: number; still?: boolean }) {
  return (
    <g transform={`translate(${stone.x} ${stone.y - 20})`}>
      <g key={run} className={`hs-ghost${still ? " still" : ""}`}>
        <path d={GHOST} fill="url(#hs-ghost)" filter="url(#hs-ghost-glow)" />
        <path d={GHOST} fill="url(#hs-ghost)" />
        <path d="M-8 -3.5c-3 .6-4.2 2.6-4.6 4.6 1.6-1.4 3.2-1.8 4.8-1.8Z" fill="url(#hs-ghost)" />
        <path d="M8 -3.5c3 .6 4.2 2.6 4.6 4.6-1.6-1.4-3.2-1.8-4.8-1.8Z" fill="url(#hs-ghost)" />
        <ellipse cx="-2.9" cy="-8.4" rx="1.5" ry="2" fill="#1a1024" />
        <ellipse cx="2.9" cy="-8.4" rx="1.5" ry="2" fill="#1a1024" />
        <ellipse cx="0" cy="-3.4" rx="1.6" ry="2" fill="#1a1024" />
        <ellipse cx="-5" cy="-5" rx="1.3" ry=".7" fill="#ffb3c7" opacity=".55" />
        <ellipse cx="5" cy="-5" rx="1.3" ry=".7" fill="#ffb3c7" opacity=".55" />
      </g>
    </g>
  );
}

function Tombstone({ stone, onClick }: { stone: Stone; onClick: () => void }) {
  return (
    <g transform={`translate(${stone.x} ${stone.y}) rotate(${stone.tilt})`} className="hs-stone hs-hit" onClick={onClick}>
      <path d={stone.shape} fill="url(#hs-stone)" />
      <path d={stone.shape} fill="none" stroke="#9a86b5" strokeOpacity=".4" strokeWidth=".7" />
      {stone.lines.map(([text, y, size]) => (
        <g key={text} fontSize={size} textAnchor="middle" className="hs-epitaph">
          <text y={y + 0.45} fill="#8e7ba6" opacity=".45">
            {text}
          </text>
          <text y={y} fill="#1d1529">
            {text}
          </text>
        </g>
      ))}
      {stone.crack && <path d={stone.crack} stroke="#231a30" strokeWidth=".6" fill="none" strokeLinejoin="round" />}
      <path d="M-12.5 6.6c2.4-1.8 5.4-2 7.6-.6 1 .6 1.2 1.6.4 2.2H-12.5Z" fill="#4a6a32" opacity=".8" />
      <path d="M12 7.4c-1.8-1.4-4.2-1.6-6-.4-.8.6-.6 1.4.2 1.6H12Z" fill="#4a6a32" opacity=".65" />
    </g>
  );
}

const GHOST_MS = 3600;

/** `still` shows the jQuery ghost mid-sentence and frozen (for previews). */
function Graveyard({ still }: { still?: boolean }) {
  const [run, rise] = useReaction(GHOST_MS);
  const [haunted, setHaunted] = useState<{ stone: number; text: string } | null>(null);
  const said = useRef(STONES.map(() => 0));

  const raise = (i: number) => {
    const says = STONES[i].says;
    setHaunted({ stone: i, text: says[said.current[i]++ % says.length] });
    rise();
  };
  const stone = haunted && run ? STONES[haunted.stone] : null;

  if (still) {
    const s = STONES[1];
    return (
      <>
        <Ghost stone={s} run={0} still />
        {STONES.map((t, i) => (
          <Tombstone key={i} stone={t} onClick={() => {}} />
        ))}
        <Bubble x={s.x} y={s.y - 66} text={s.says[0]} ms={GHOST_MS} still />
      </>
    );
  }

  return (
    <>
      {stone && <Ghost stone={stone} run={run} />}
      {STONES.map((s, i) => (
        <Tombstone key={i} stone={s} onClick={() => raise(i)} />
      ))}
      {stone && haunted && <Bubble key={run} x={stone.x} y={stone.y - 66} text={haunted.text} ms={GHOST_MS} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Fence

const FENCE_BARS = Array.from({ length: 11 }, (_, i) => 6 + i * 6.2);

function Fence() {
  return (
    <g fill="#0d0814">
      <rect x="3" y="152.5" width="67" height="1.3" />
      <rect x="3" y="161" width="67" height="1.3" />
      {FENCE_BARS.map((x, i) => (
        <g key={x} transform={i === 7 ? `rotate(-9 ${x} 170)` : i === 8 ? `rotate(5 ${x} 170)` : undefined}>
          <rect x={x - 0.6} y="149" width="1.2" height="22" />
          <path d={`M${x - 1.6} 149.6L${x} 145.2 ${x + 1.6} 149.6Z`} />
        </g>
      ))}
    </g>
  );
}

// ---------------------------------------------------------------------------
// A crooked signpost on the middle hill

function Signpost() {
  return (
    <g transform="rotate(-6 146 164)">
      <rect x="145" y="141" width="2.2" height="24" fill="#2b1c14" />
      <path d="M137 142.5h22.5l4 3.6-4 3.6H137Z" fill="url(#hs-wood)" />
      <path d="M137 142.5h22.5l4 3.6-4 3.6H137Z" fill="none" stroke="#1a0f0a" strokeWidth=".5" />
      <path d="M140 144.6h4M150 147.6h6" stroke="#4a3020" strokeWidth=".35" />
      <text x="149" y="148.2" textAnchor="middle" className="hs-sign">
        prod
      </text>
      <circle cx="146.1" cy="144.2" r=".45" fill="#1a0f0a" />
    </g>
  );
}

// ---------------------------------------------------------------------------
// The jack-o'-lantern

const EMBERS = [
  [-7, -22, 0],
  [4, -28, 0.08],
  [-2, -34, 0.16],
  [9, -20, 0.05],
  [-11, -16, 0.12],
  [1, -24, 0.22],
  [6, -36, 0.3],
];

function JackOLantern() {
  const [cackle, laugh] = useReaction(1500);
  const mouth = cackle
    ? "M148.6 184.2Q160 199 171.4 184.2Q169.6 185.4 167.6 185.8L166 189 164.2 186.4Q160 187 155.8 186.4L154 189 152.4 185.8Q150.4 185.4 148.6 184.2Z"
    : "M149 185Q160 195 171 185Q169.5 186.4 167.5 186.8L166 189 164.5 187.2Q160 187.8 155.5 187.2L154 189 152.5 186.8Q150.5 186.4 149 185Z";
  const face = (
    <>
      <path d={cackle ? "M149 178.6L156.4 179.4 152.2 171.4Z" : "M149.5 179L156 179 152.8 173Z"} />
      <path d={cackle ? "M163.6 179.4L171 178.6 167.8 171.4Z" : "M164 179L170.5 179 167.2 173Z"} />
      <path d="M158.6 183.2L161.4 183.2 160 180.6Z" />
      <path d={mouth} />
    </>
  );
  return (
    <g>
      <ellipse cx="161" cy="195" rx="23" ry="3.4" fill="#000" opacity=".45" />
      <ellipse className="hs-candle" cx="160" cy="183" rx="34" ry="22" fill="#ff8a1f" opacity=".2" filter="url(#hs-wide-glow)" />
      <g className={`hs-pumpkin hs-hit${cackle ? " cackle" : ""}`} onClick={laugh}>
        <g key={cackle}>
          <ellipse cx="147" cy="183" rx="10.5" ry="12" fill="url(#hs-pumpkin-side)" />
          <ellipse cx="173" cy="183" rx="10.5" ry="12" fill="url(#hs-pumpkin-side)" />
          <ellipse cx="153.5" cy="182.6" rx="10.5" ry="13.2" fill="url(#hs-pumpkin)" />
          <ellipse cx="166.5" cy="182.6" rx="10.5" ry="13.2" fill="url(#hs-pumpkin)" />
          <ellipse cx="160" cy="182.4" rx="9.2" ry="13.8" fill="url(#hs-pumpkin)" />
          <g fill="none" stroke="#a8420a" strokeOpacity=".55" strokeWidth=".6">
            <path d="M151.5 170.4Q147.8 182.6 151.5 195.2M168.5 170.4Q172.2 182.6 168.5 195.2" />
            <path d="M142 174.6Q139.6 183 142 191.4M178 174.6Q180.4 183 178 191.4" />
          </g>
          <ellipse cx="155" cy="174.4" rx="4.6" ry="1.6" fill="#ffd49a" opacity=".28" transform="rotate(-14 155 174.4)" />
          <path d="M158.2 169.6C158 164.8 160 161.8 164 159.8L165.6 161.4C162.8 163.4 161.8 166.2 162.4 169.8Z" fill="url(#hs-stem)" />
          <path d="M164.6 161c2.4-1.4 4.6-.6 4.8 1.4.2 1.6-1.4 2.2-2.2 1.2" fill="none" stroke="#56692a" strokeWidth=".7" strokeLinecap="round" />
          {/* The carving: a blurred copy throws the light, the cut edge is darker. */}
          <g className="hs-face-glow" fill="#ffb52e" filter="url(#hs-glow)">
            {face}
          </g>
          <g fill="url(#hs-carve)" stroke="#7a2e04" strokeWidth=".5">
            {face}
          </g>
        </g>
      </g>
      {cackle > 0 && (
        <g key={cackle} className="hs-embers">
          {EMBERS.map(([dx, dy, delay], i) => (
            <circle
              key={i}
              cx="160"
              cy="180"
              r={i % 3 === 0 ? 1.1 : 0.75}
              style={{ "--dx": `${dx}px`, "--dy": `${dy}px`, animationDelay: `${delay}s` } as CSSProperties}
            />
          ))}
        </g>
      )}
      {/* A small uncarved one keeps it company. */}
      <ellipse cx="188" cy="192" rx="7.2" ry="5.6" fill="url(#hs-pumpkin-side)" />
      <ellipse cx="188" cy="191.8" rx="4.2" ry="5.8" fill="url(#hs-pumpkin)" />
      <path d="M187.4 186.6c0-1.6.8-2.8 2.2-3.4l.6.7c-1 .6-1.4 1.5-1.4 2.7Z" fill="url(#hs-stem)" />
    </g>
  );
}

// ---------------------------------------------------------------------------

function Defs() {
  return (
    <defs>
      <linearGradient id="hs-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#150f1c" stopOpacity="0" />
        <stop offset=".4" stopColor="#1d1430" stopOpacity=".9" />
        <stop offset="1" stopColor="#2c1c42" />
      </linearGradient>
      <radialGradient id="hs-halo">
        <stop offset=".3" stopColor="#ffd79a" stopOpacity=".34" />
        <stop offset=".55" stopColor="#ff9e4a" stopOpacity=".1" />
        <stop offset="1" stopColor="#ff9e4a" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="hs-moon" cx=".36" cy=".32" r=".8">
        <stop offset="0" stopColor="#fff7e2" />
        <stop offset=".5" stopColor="#f8dca6" />
        <stop offset="1" stopColor="#e2a862" />
      </radialGradient>
      <radialGradient id="hs-moon-shade" cx=".3" cy=".28" r=".9">
        <stop offset=".62" stopColor="#5a3060" stopOpacity="0" />
        <stop offset="1" stopColor="#5a3060" stopOpacity=".38" />
      </radialGradient>
      <radialGradient id="hs-crater" cx=".4" cy=".4">
        <stop offset="0" stopColor="#d49a58" stopOpacity=".75" />
        <stop offset="1" stopColor="#e7b876" stopOpacity=".35" />
      </radialGradient>
      <linearGradient id="hs-far" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#2a1a3a" />
        <stop offset=".4" stopColor="#1c1228" />
      </linearGradient>
      <linearGradient id="hs-mid" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#21152e" />
        <stop offset=".35" stopColor="#140d1e" />
      </linearGradient>
      <linearGradient id="hs-near" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#120b1a" />
        <stop offset="1" stopColor="#09050e" />
      </linearGradient>
      <linearGradient id="hs-wood" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#7a5236" />
        <stop offset="1" stopColor="#4e3220" />
      </linearGradient>
      <linearGradient id="hs-window" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffe08a" />
        <stop offset="1" stopColor="#ff9d2e" />
      </linearGradient>
      <radialGradient id="hs-owl-eye">
        <stop offset="0" stopColor="#fff3a6" />
        <stop offset="1" stopColor="#ffab1f" />
      </radialGradient>
      <linearGradient id="hs-stone" x1="0" y1="0" x2=".5" y2="1">
        <stop offset="0" stopColor="#6a5a82" />
        <stop offset=".45" stopColor="#4a3d60" />
        <stop offset="1" stopColor="#2a2139" />
      </linearGradient>
      <linearGradient id="hs-ghost" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset=".7" stopColor="#efe6ff" stopOpacity=".95" />
        <stop offset="1" stopColor="#d9c8ff" stopOpacity=".55" />
      </linearGradient>
      <radialGradient id="hs-pumpkin" cx=".4" cy=".34" r=".75">
        <stop offset="0" stopColor="#ffab4f" />
        <stop offset=".55" stopColor="#f57a1c" />
        <stop offset="1" stopColor="#bd4b09" />
      </radialGradient>
      <radialGradient id="hs-pumpkin-side" cx=".5" cy=".38" r=".75">
        <stop offset="0" stopColor="#e86a18" />
        <stop offset="1" stopColor="#8f3405" />
      </radialGradient>
      <linearGradient id="hs-stem" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#8a8f3c" />
        <stop offset="1" stopColor="#4a4a1e" />
      </linearGradient>
      <radialGradient id="hs-carve" cx=".5" cy=".55" r=".7">
        <stop offset="0" stopColor="#fff6b8" />
        <stop offset=".45" stopColor="#ffcf4a" />
        <stop offset="1" stopColor="#ff8a12" />
      </radialGradient>
      <filter id="hs-glow" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="1.8" />
      </filter>
      <filter id="hs-wide-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="7" />
      </filter>
      <filter id="hs-ghost-glow" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="2.6" />
      </filter>
      <filter id="hs-soft" x="-30%" y="-80%" width="160%" height="260%">
        <feGaussianBlur stdDeviation="1.4" />
      </filter>
      <filter id="hs-fog" x="-20%" y="-200%" width="140%" height="500%">
        <feGaussianBlur stdDeviation="4" />
      </filter>
    </defs>
  );
}

/** `still` freezes a ghost mid-sentence, for static previews (README cards). */
export default function HalloweenScene({ still = false }: { still?: boolean }) {
  return (
    <svg className="hs" viewBox={`0 0 ${W} 200`} preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <Defs />
      <Sky />
      <Moon />
      <Cloud y={70} scale={1.25} duration={70} delay={-26} tone="#2f1f44" />
      <Cloud y={40} scale={0.8} duration={95} delay={-70} tone="#3a2853" />
      <Spider />
      <Bat x={60} y={34} scale={0.95} duration={16} delay={-5} />
      <Bat x={128} y={56} scale={0.7} duration={22} delay={-14} />
      <Bat x={150} y={88} scale={0.55} duration={27} delay={-21} />
      <path d="M0 148C30 132 70 126 110 131 150 136 190 140 240 127V200H0Z" fill="url(#hs-far)" />
      <path d="M0 148C30 132 70 126 110 131 150 136 190 140 240 127" className="hs-rim" />
      <House />
      <path d="M0 168C40 156 80 151 120 157 160 163 200 149 240 153V200H0Z" fill="url(#hs-mid)" />
      <path d="M0 168C40 156 80 151 120 157 160 163 200 149 240 153" className="hs-rim" />
      <Fence />
      <Signpost />
      <Tree />
      <Owl />
      <Graveyard still={still} />
      <path d="M0 187C50 180 100 182 140 185 180 188 210 182 240 184V200H0Z" fill="url(#hs-near)" />
      <g fill="#0c0712">
        <path d="M18 186l1.2-4 .8 3.6 1-5 1 5.4ZM48 183.4l1-3.4.9 3 1-4.2.8 4.6ZM92 183.6l1-3.2.8 2.8 1.2-4 .8 4.4ZM128 185.4l1-3 .9 2.6 1-3.6.9 4ZM222 184.6l1-3 .9 2.6 1-3.6.9 4Z" />
      </g>
      <JackOLantern />
      <g className="hs-fog" fill="#a492c4" filter="url(#hs-fog)">
        <ellipse className="hs-fog-a" cx="60" cy="188" rx="70" ry="6" opacity=".14" />
        <ellipse className="hs-fog-b" cx="190" cy="176" rx="60" ry="5" opacity=".1" />
      </g>
    </svg>
  );
}
