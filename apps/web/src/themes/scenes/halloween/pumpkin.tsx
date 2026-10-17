import { css, useReaction } from "./kit";

// ---------------------------------------------------------------------------
// The jack-o'-lantern: seven lobes shaded back to front, a curled stem with a
// vine and a leaf, and a carved face that shows the thickness of its wall and
// glows from the candle inside. A click makes it cackle and throw embers.

const PX = 186;
const PY = 236;

const LOBES: [number, number, number, string][] = [
  // offset, rx, ry, fill — outermost first, so the centre lobe overlaps all.
  [-17, 8, 13, "url(#hs-pk-2)"],
  [17, 8, 13, "url(#hs-pk-2)"],
  [-11, 10, 15.5, "url(#hs-pk-1)"],
  [11, 10, 15.5, "url(#hs-pk-1)"],
  [-5.5, 10.5, 16.5, "url(#hs-pk-0)"],
  [5.5, 10.5, 16.5, "url(#hs-pk-0)"],
  [0, 10, 17, "url(#hs-pk-0)"],
];

const FACE = {
  eyes: "M-12-2H-4.5L-8.5-9.6ZM4.5-2H12L8.5-9.6Z",
  nose: "M-1.8 2.6H1.8L0-.8Z",
  mouth: "M-13 5Q0 18 13 5 11 6.6 8.6 7L7 9.8 5 7.6Q0 8.4-5 7.6L-7 9.8-8.6 7Q-11 6.6-13 5Z",
};
const CACKLE = {
  eyes: "M-12.6-3Q-8.4-10-4-3-8.4-6.4-12.6-3ZM4-3Q8.4-10 12.6-3 8.4-6.4 4-3Z",
  nose: FACE.nose,
  mouth: "M-14.4 3.6Q0 23 14.4 3.6 12.2 5.8 9.6 6.4L7.6 10.6 5.4 7.6Q0 8.8-5.4 7.6L-7.6 10.6-9.6 6.4Q-12.2 5.8-14.4 3.6Z",
};

const EMBERS = [
  [-9, -30, 0],
  [5, -38, 0.06],
  [-2, -46, 0.12],
  [12, -28, 0.04],
  [-14, -22, 0.1],
  [1, -34, 0.18],
  [8, -50, 0.24],
  [-6, -40, 0.3],
  [15, -42, 0.16],
];

function JackOLantern() {
  const [cackle, laugh] = useReaction(1600);
  const face = cackle ? CACKLE : FACE;
  const holes = `${face.eyes}${face.nose}${face.mouth}`;
  return (
    <g transform={`translate(${PX} ${PY})`}>
      <ellipse cy="17.6" rx="27" ry="3.6" fill="#000" opacity=".55" />
      <g className={`hs-pumpkin hs-hit${cackle ? " cackle" : ""}`} onClick={laugh}>
        <g key={cackle}>
          {LOBES.map(([dx, rx, ry, fill], i) => (
            <ellipse key={i} cx={dx} cy={Math.abs(dx) * 0.06} rx={rx} ry={ry} fill={fill} stroke="#7a2c04" strokeOpacity=".35" strokeWidth=".5" />
          ))}
          <ellipse cx="-7" cy="-11" rx="4.6" ry="1.8" fill="#ffe2b4" opacity=".3" transform="rotate(-22 -7 -11)" />
          <ellipse cx="2" cy="-13" rx="2.6" ry="1.1" fill="#ffe2b4" opacity=".22" transform="rotate(-8 2 -13)" />
          <ellipse cy="13" rx="20" ry="4" fill="#4a1802" opacity=".35" />
          {/* Stem, its cut top, fibres; then the vine and a leaf. */}
          <path d="M-2.2-15.4C-2.6-20.6-.6-24.8 3.6-27L5.8-25.2C2.8-23.2 1.6-20 2.4-15.4Z" fill="url(#hs-pk-stem)" />
          <ellipse cx="4.7" cy="-26.1" rx="1.5" ry=".75" fill="#b4b070" transform="rotate(-40 4.7 -26.1)" />
          <path d="M-.6-16.4C-.8-20-.2-22.4 2-24.6M.8-16.4C.8-19.4 1.4-21.6 3.2-23.6" stroke="#3e3e18" strokeWidth=".35" fill="none" />
          <path d="M2-16.6C7-20.6 13.4-19.2 14.4-15 15.2-11.4 11.2-10.2 10.6-12.8 10.2-14.6 12.6-15.2 12.9-13.6" stroke="#4d6b2a" strokeWidth=".75" fill="none" strokeLinecap="round" />
          <path d="M-2-16.2C-5.4-20.8-11.2-21.6-14.4-18.4-11.4-17.6-9.2-15.4-8.4-13-6-15.8-3.8-16.4-2-16.2Z" fill="url(#hs-pk-leaf)" />
          <path d="M-2.2-16.2C-6-17.4-9.6-17.8-13.4-18.4M-6.4-17.2l-1.6 2M-9.6-17.8l-.6 2.4" stroke="#2a4218" strokeWidth=".35" fill="none" />
          {/* The carving. Inside the holes: lit flesh (the cut wall), then the
              glowing interior offset down-right, so the wall shows top-left. */}
          <clipPath id="hs-face-clip">
            <path d={holes} />
          </clipPath>
          <g clipPath="url(#hs-face-clip)">
            <rect x="-16" y="-12" width="32" height="26" fill="#ffc074" />
            <path d={holes} transform="translate(.8 1.1)" fill="url(#hs-carve)" />
          </g>
          <path d={holes} fill="none" stroke="#6a2402" strokeWidth=".55" strokeLinejoin="round" />
          <path d={holes} fill="#ffd25a" filter="url(#hs-bloom)" className="hs-face-glow" />
        </g>
      </g>
      {cackle > 0 && (
        <g key={cackle} className="hs-embers">
          {EMBERS.map(([dx, dy, delay], i) => (
            <circle
              key={i}
              cy="-2"
              r={i % 3 === 0 ? 1.6 : 1.1}
              fill="url(#hs-ember)"
              style={css({ "--dx": `${dx}px`, "--dy": `${dy}px`, animationDelay: `${delay}s` })}
            />
          ))}
        </g>
      )}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Company: a small orange pumpkin, a pale "ghost" pumpkin, fallen leaves.

function SmallPumpkin({ x, y, s, pale = false }: { x: number; y: number; s: number; pale?: boolean }) {
  const [a, b] = pale ? ["url(#hs-pale-1)", "url(#hs-pale-0)"] : ["url(#hs-pk-1)", "url(#hs-pk-0)"];
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <ellipse cy="7.4" rx="11" ry="2" fill="#000" opacity=".5" />
      <ellipse cx="-4.6" rx="6" ry="7.2" fill={a} />
      <ellipse cx="4.6" rx="6" ry="7.2" fill={a} />
      <ellipse rx="5.6" ry="7.6" fill={b} />
      <ellipse cx="-2.4" cy="-4.2" rx="2" ry=".9" fill="#fff4e0" opacity=".28" transform="rotate(-20 -2.4 -4.2)" />
      <path d="M-.6-7C-.8-9.4.2-11 2-11.8L2.8-11C1.6-10.2 1.2-8.8 1.4-7Z" fill={pale ? "#7a7a5a" : "url(#hs-pk-stem)"} />
    </g>
  );
}

const LEAF = "M0-3.4C.6-2.2 1.8-2.6 2.4-3 2.2-1.8 3-1.2 3.6-1 2.6-.4 2.6.4 2.8 1 1.8.6 1 1 .4 1.6V2.6H-.4V1.6C-1 1-1.8.6-2.8 1-2.6.4-2.6-.4-3.6-1-3-1.2-2.2-1.8-2.4-3-1.8-2.6-.6-2.2 0-3.4Z";

const LEAVES: [number, number, number, number, string][] = [
  [158, 252, 30, 0.9, "#c4561a"],
  [166, 257, -40, 0.75, "#8a3a12"],
  [210, 256, 70, 0.85, "#d88a2a"],
  [230, 251, -20, 0.7, "#b0481a"],
  [146, 247, 110, 0.6, "#d88a2a"],
];

export function Pumpkins() {
  return (
    <g>
      <defs>
        <radialGradient id="hs-pk-0" cx=".42" cy=".3" r=".8">
          <stop offset="0" stopColor="#ffb862" />
          <stop offset=".55" stopColor="#f57a1c" />
          <stop offset="1" stopColor="#ad4209" />
        </radialGradient>
        <radialGradient id="hs-pk-1" cx=".45" cy=".32" r=".8">
          <stop offset="0" stopColor="#f08a2e" />
          <stop offset=".6" stopColor="#c4550c" />
          <stop offset="1" stopColor="#7e2e04" />
        </radialGradient>
        <radialGradient id="hs-pk-2" cx=".5" cy=".34" r=".8">
          <stop offset="0" stopColor="#d06418" />
          <stop offset=".6" stopColor="#8f3405" />
          <stop offset="1" stopColor="#521b02" />
        </radialGradient>
        <radialGradient id="hs-pale-0" cx=".42" cy=".3" r=".8">
          <stop offset="0" stopColor="#fbf3e4" />
          <stop offset=".6" stopColor="#d9cbb2" />
          <stop offset="1" stopColor="#8f7f6a" />
        </radialGradient>
        <radialGradient id="hs-pale-1" cx=".5" cy=".34" r=".8">
          <stop offset="0" stopColor="#cdbfa6" />
          <stop offset="1" stopColor="#6e604e" />
        </radialGradient>
        <linearGradient id="hs-pk-stem" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#9a9a48" />
          <stop offset="1" stopColor="#4a4a1c" />
        </linearGradient>
        <linearGradient id="hs-pk-leaf" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3a5a24" />
          <stop offset="1" stopColor="#5e8a34" />
        </linearGradient>
        <radialGradient id="hs-carve" cx=".5" cy=".6" r=".7">
          <stop offset="0" stopColor="#fff8c8" />
          <stop offset=".4" stopColor="#ffd24a" />
          <stop offset="1" stopColor="#ff8a12" />
        </radialGradient>
        <radialGradient id="hs-ember">
          <stop offset="0" stopColor="#fff2a0" />
          <stop offset=".4" stopColor="#ffb52e" stopOpacity=".9" />
          <stop offset="1" stopColor="#ff6a00" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="hs-pk-halo">
          <stop offset="0" stopColor="#ff9a3a" stopOpacity=".42" />
          <stop offset=".5" stopColor="#ff8a1f" stopOpacity=".12" />
          <stop offset="1" stopColor="#ff8a1f" stopOpacity="0" />
        </radialGradient>
        <filter id="hs-bloom" x="-30%" y="-60%" width="160%" height="220%">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
      </defs>
      {/* Candlelight on everything around it (screen blend lightens only). */}
      <ellipse cx={PX} cy={PY + 2} rx="66" ry="40" fill="url(#hs-pk-halo)" className="hs-flicker hs-light" />
      {LEAVES.map(([x, y, r, s, fill], i) => (
        <path key={i} d={LEAF} fill={fill} transform={`translate(${x} ${y}) rotate(${r}) scale(${s})`} opacity=".9" />
      ))}
      <SmallPumpkin x={154} y={250} s={0.7} pale />
      <JackOLantern />
      <SmallPumpkin x={219} y={249} s={0.95} />
    </g>
  );
}
