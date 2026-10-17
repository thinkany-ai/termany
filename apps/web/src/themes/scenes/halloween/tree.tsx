import { crest, groundAt, hillShape, useReaction, useSay, type Hill } from "./kit";

export const MID: Hill = {
  start: [0, 206],
  curves: [
    [40, 196, 80, 190, 120, 193],
    [160, 196, 200, 182, 240, 186],
  ],
};

export function MidHill() {
  return (
    <g>
      <defs>
        <linearGradient id="hs-trail" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a2a50" stopOpacity=".5" />
          <stop offset="1" stopColor="#2a1d3c" stopOpacity=".9" />
        </linearGradient>
        <linearGradient id="hs-mid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#21152f" />
          <stop offset=".3" stopColor="#150d20" />
        </linearGradient>
      </defs>
      <path d={hillShape(MID)} fill="url(#hs-mid)" />
      {/* The path from the graveyard up to the house, through the fence gap. */}
      <path d="M74.4 234C76 220 77 206 77.6 192 78.6 192 79.6 192 80.6 192 82 206 84 220 88 234Z" fill="url(#hs-trail)" />
      <path d={crest(MID)} className="hs-rim" />
    </g>
  );
}

// ---------------------------------------------------------------------------
// A wrought-iron fence along the middle hill: fleur-de-lis finials, two rails
// that follow the ground, scrolls between the bars, and a gap where two bars
// have fallen.

const FENCE_XS = Array.from({ length: 21 }, (_, i) => 3 + i * 5.4).filter((x) => x < 74 || x > 84);

export function Fence() {
  const top = (x: number) => groundAt(MID, x) - 15;
  const rail = (dy: number, from: number, to: number) => {
    let d = "";
    for (let x = from; x <= to; x += 2) d += `${x === from ? "M" : "L"}${x} ${(groundAt(MID, x) + dy).toFixed(2)}`;
    return d;
  };
  return (
    <g className="hs-fence">
      <path d={`${rail(-12, 2, 72)}${rail(-12, 86, 112)}${rail(-3.5, 2, 72)}${rail(-3.5, 86, 112)}`} fill="none" stroke="#0b0612" strokeWidth="1.1" />
      {FENCE_XS.map((x, i) => {
        const y = top(x);
        const lean = i === 12 ? -8 : i === 3 ? 4 : 0;
        return (
          <g key={x} transform={lean ? `rotate(${lean} ${x} ${y + 18})` : undefined} fill="#0b0612">
            <rect x={x - 0.5} y={y} width="1" height="19" />
            <path d={`M${x} ${y - 3.6}C${x + 1} ${y - 2.4} ${x + 1} ${y - 0.9} ${x} ${y}C${x - 1} ${y - 0.9} ${x - 1} ${y - 2.4} ${x} ${y - 3.6}Z`} />
            <path d={`M${x - 0.4} ${y - 0.4}c-1.4-.2-1.8-1.4-1.2-2.2M${x + 0.4} ${y - 0.4}c1.4-.2 1.8-1.4 1.2-2.2`} fill="none" stroke="#0b0612" strokeWidth=".45" />
          </g>
        );
      })}
      {FENCE_XS.slice(0, -1)
        .filter((x, i) => FENCE_XS[i + 1] - x < 6)
        .map((x) => {
          const y = groundAt(MID, x + 2.7) - 9.6;
          return <path key={x} d={`M${x + 0.6} ${y}c1.2-1.6 3-1.6 3.8 0s-.6 2.4-1.4 1.6`} fill="none" stroke="#0b0612" strokeWidth=".45" />;
        })}
    </g>
  );
}

// ---------------------------------------------------------------------------
// The tree: a gnarled trunk on the middle hill, branches that taper to points,
// moonlight down its right side, and a knot-hole where something blinks.

export function Tree() {
  return (
    <g>
      <defs>
        <linearGradient id="hs-bark" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#0d0716" />
          <stop offset=".7" stopColor="#1a1027" />
          <stop offset="1" stopColor="#2a1c3c" />
        </linearGradient>
      </defs>
      <g fill="url(#hs-bark)">
        <path d="M205 194C209.6 182 212 170 210 158 208 146 212 132 217 122 220 116 222 110 221 102H224.4C225.4 110 223.4 118 221.4 124 217.6 134 215.6 146 217.6 158 219.6 170 220.6 182 227 194Z" />
        <path d="M203 194.6C205.4 191.4 208 190.2 211 190.4L212.6 194.6ZM224 194.6C226.4 191 230.6 190.8 234 192.4 231 192.8 229 193.6 228 194.6Z" />
        <path d="M212.4 148C204.4 140 196.4 132 190.4 122 188.2 118 184.2 115.2 179.6 116 184.8 117.6 187.8 120.8 189.8 125.4 194.8 135 202.8 143.4 211 152.4Z" />
        <path d="M196.6 132.4C192.4 132.2 188.4 134.4 183 133.2 188 136.2 192.2 136.6 197.6 135.4Z" />
        <path d="M190.2 124.6C189 119.4 191 114.4 188.8 108.8 192.2 113 193.2 118.4 192.4 124.4Z" />
        <path d="M219.2 130.4C225.2 124.2 231.2 118 236.2 108 237.2 106 239.2 105 240.6 106 238.2 109.4 235.2 116.4 232.2 121.4 228.2 127.4 223.2 132.4 220.2 135.4Z" />
        <path d="M221 104.6C222 96.6 219 90.6 222 82.4 223.2 86.6 223.2 92.6 224.2 98.6Z" />
        <path d="M222.4 108.4C226.4 102.4 230.4 98.4 233.4 92.2 233.6 96.4 230.4 101.4 227.4 106.6Z" />
        <path d="M218 112.4C214 106.4 210 103.4 205.6 97.2 210 100.2 214 103 219.4 108.2Z" />
      </g>
      <path
        d="M224.4 102C225.4 110 223.4 118 221.4 124 217.6 134 215.6 146 217.6 158 219.6 170 220.6 182 227 194M236.2 108C237.2 106 239.2 105 240.6 106"
        className="hs-rim"
      />
      <path d="M213.8 172c.6-3 .4-6-.4-8.6M215.2 140c-.8-2.4-.6-4.6.4-6.6M211.4 182c-.4-2 0-3.8.8-5.2" stroke="#2a1c3a" strokeWidth=".45" fill="none" strokeLinecap="round" />
      <ellipse cx="214" cy="160" rx="2.3" ry="3.2" fill="#05030a" />
      <path d="M211.8 158.2c.6-1.8 3.8-1.8 4.4 0" stroke="#2a1c3c" strokeWidth=".5" fill="none" />
      <g className="hs-knot-eyes" fill="#ffd34a">
        <ellipse cx="213.2" cy="160.4" rx=".55" ry=".4" />
        <ellipse cx="214.8" cy="160.4" rx=".55" ry=".4" />
      </g>
    </g>
  );
}

// ---------------------------------------------------------------------------
// The owl, perched on the left branch. A click turns its head.

const OWL_MS = 2800;

export function Owl() {
  const [hoot, turn] = useReaction(OWL_MS);
  const say = useSay();
  return (
    <g
      className={`hs-owl hs-hit${hoot ? " hoot" : ""}`}
      onClick={() => {
        turn();
        say(198.5, 107, "whooo wrote this?", OWL_MS);
      }}
    >
      <defs>
        <radialGradient id="hs-owl-body" cx=".62" cy=".3" r=".9">
          <stop offset="0" stopColor="#5a4474" />
          <stop offset=".6" stopColor="#3a2a4e" />
          <stop offset="1" stopColor="#24182f" />
        </radialGradient>
        <radialGradient id="hs-owl-eye">
          <stop offset="0" stopColor="#fff6b0" />
          <stop offset=".6" stopColor="#ffc531" />
          <stop offset="1" stopColor="#e07a10" />
        </radialGradient>
      </defs>
      <rect x="190" y="106" width="17" height="30" fill="transparent" />
      {/* Body, wings and the pale chest with chevron feathers. */}
      <ellipse cx="198.5" cy="126.4" rx="6.2" ry="8.4" fill="url(#hs-owl-body)" />
      <path d="M192.6 123c-1 4-.4 8 1.6 10.4 1-3 1.2-6.6.4-10.6Z" fill="#2a1d38" />
      <path d="M204.4 123c1 4 .4 8-1.6 10.4-1-3-1.2-6.6-.4-10.6Z" fill="#2a1d38" />
      <ellipse cx="198.5" cy="128.4" rx="3.8" ry="5.2" fill="#7c6694" />
      <path
        d="M196.4 125.6q.9.8 1.8 0M198.8 125.6q.9.8 1.8 0M195.6 128.2q.9.8 1.8 0M198 128.2q.9.8 1.8 0M200.4 128.2q.9.8 1.8 0M196.6 130.8q.9.8 1.8 0M199 130.8q.9.8 1.8 0"
        stroke="#4a3660"
        strokeWidth=".45"
        fill="none"
      />
      <path d="M204.6 122.2a6.2 8.4 0 0 1-1.8 10.4" className="hs-rim" strokeOpacity=".6" />
      {/* Talons on the branch. */}
      <path d="M195.8 134.4l-.4 1.4M197.4 134.8v1.4M199.6 134.8v1.4M201.2 134.4l.4 1.4" stroke="#d09452" strokeWidth=".6" strokeLinecap="round" />
      <g className="hs-owl-head">
        <path d="M193 116.6l-1.2-5.2 3.8 3ZM204 116.6l1.2-5.2-3.8 3Z" fill="#3a2a4e" />
        <ellipse cx="198.5" cy="117.4" rx="6.4" ry="5.2" fill="url(#hs-owl-body)" />
        <circle cx="196" cy="117.2" r="2.9" fill="#5e4878" />
        <circle cx="201" cy="117.2" r="2.9" fill="#5e4878" />
        <g className="hs-owl-eyes">
          <circle cx="196" cy="117.2" r="2.2" fill="url(#hs-owl-eye)" />
          <circle cx="201" cy="117.2" r="2.2" fill="url(#hs-owl-eye)" />
          <circle cx="196.2" cy="117.3" r="1.05" fill="#140a14" />
          <circle cx="201.2" cy="117.3" r="1.05" fill="#140a14" />
          <circle cx="195.6" cy="116.6" r=".4" fill="#fffbe6" />
          <circle cx="200.6" cy="116.6" r=".4" fill="#fffbe6" />
        </g>
        <path d="M197.9 119.2h1.2l-.6 1.6Z" fill="#d09452" />
        <path d="M204.6 115.6a6.4 5.2 0 0 1-.6 4.4" className="hs-rim" strokeOpacity=".6" />
      </g>
    </g>
  );
}

// ---------------------------------------------------------------------------
// A lantern swinging from the right branch, and a spider on a thread from the
// left one.

export function Lantern() {
  return (
    <g>
      <defs>
        <radialGradient id="hs-lantern-glow">
          <stop offset="0" stopColor="#ffb547" stopOpacity=".5" />
          <stop offset=".5" stopColor="#ff8a1f" stopOpacity=".14" />
          <stop offset="1" stopColor="#ff8a1f" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="hs-flame" cx=".5" cy=".7" r=".7">
          <stop offset="0" stopColor="#fffbe0" />
          <stop offset=".45" stopColor="#ffc93a" />
          <stop offset="1" stopColor="#ff6a00" />
        </radialGradient>
        <linearGradient id="hs-glass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd987" stopOpacity=".55" />
          <stop offset="1" stopColor="#ff9d3a" stopOpacity=".7" />
        </linearGradient>
      </defs>
      <g className="hs-lantern">
        <path d="M231.4 121.6V129" stroke="#0b0612" strokeWidth=".5" />
        <circle cx="231.4" cy="138" r="16" fill="url(#hs-lantern-glow)" className="hs-flicker" />
        <path d="M228.6 131.6h5.6l-.8-2.2h-4Z" fill="#140b1e" />
        <circle cx="231.4" cy="128.6" r=".9" fill="none" stroke="#140b1e" strokeWidth=".5" />
        <rect x="228.8" y="131.6" width="5.2" height="7.8" rx=".6" fill="url(#hs-glass)" />
        <path className="hs-flame" d="M231.4 133.2C232.4 134.8 232.6 136.2 231.4 137.4 230.2 136.2 230.4 134.8 231.4 133.2Z" fill="url(#hs-flame)" />
        <path d="M228.8 131.6v7.8M231.4 131.6v7.8M234 131.6v7.8" stroke="#140b1e" strokeWidth=".45" />
        <path d="M228.2 139.4h6.4l-.8 1.6h-4.8Z" fill="#140b1e" />
      </g>
    </g>
  );
}

export function Spider() {
  return (
    <g transform="translate(181 116.6)">
      <g className="hs-spider">
        <line className="hs-thread" x1="0" y1="0" x2="0" y2="22" />
        <g transform="translate(0 25)">
          <g className="hs-spider-legs">
            {[
              "M-1.5-.3C-3.4-2.6-5.4-2.6-6.8-.8",
              "M-1.7.7C-4-.5-6 .1-7.2 2.1",
              "M-1.7 1.7C-3.9 1.7-5.4 3.1-6 5.3",
              "M-1.3 2.7C-2.9 3.7-3.7 5.5-3.7 7.6",
            ].map((d) => (
              <g key={d}>
                <path d={d} />
                <path d={d} transform="scale(-1 1)" />
              </g>
            ))}
          </g>
          <ellipse className="hs-spider-body" cy="3.3" rx="2.8" ry="3.4" />
          <circle className="hs-spider-body" cy="-.4" r="1.7" />
          <path d="M-.9 1.9H.9L0 3.3ZM-.9 4.7H.9L0 3.3Z" fill="#c42a2a" />
          <circle cx="-.6" cy="-.6" r=".36" fill="#ff5a4a" />
          <circle cx=".6" cy="-.6" r=".36" fill="#ff5a4a" />
        </g>
      </g>
    </g>
  );
}
