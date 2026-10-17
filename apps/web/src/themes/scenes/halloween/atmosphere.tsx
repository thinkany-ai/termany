import { H, W } from "./kit";
import { MOON } from "./sky";

/** Faint shafts of moonlight slanting down-left across the scene. */
export function MoonShafts() {
  const { x, y } = MOON;
  return (
    <g className="hs-light" opacity=".9">
      <defs>
        <linearGradient id="hs-shaft" gradientUnits="userSpaceOnUse" x1={x} y1={y} x2={x - 120} y2={H}>
          <stop offset="0" stopColor="#ffe6c0" stopOpacity=".055" />
          <stop offset="1" stopColor="#ffe6c0" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`M${x - 10} ${y + 6}L${x - 2} ${y + 10}L${x - 64} ${H}H${x - 112}Z`} fill="url(#hs-shaft)" />
      <path d={`M${x + 2} ${y + 14}L${x + 8} ${y + 16}L${x - 20} ${H}H${x - 44}Z`} fill="url(#hs-shaft)" />
    </g>
  );
}

/** Will-o'-the-wisps drifting over the graveyard. */
export function Wisps() {
  return (
    <g>
      <defs>
        <radialGradient id="hs-wisp">
          <stop offset="0" stopColor="#e6fff8" />
          <stop offset=".18" stopColor="#7ff5d8" stopOpacity=".85" />
          <stop offset=".45" stopColor="#3fd6b4" stopOpacity=".22" />
          <stop offset="1" stopColor="#3fd6b4" stopOpacity="0" />
        </radialGradient>
      </defs>
      {[
        [44, 198, "a", 0],
        [126, 204, "b", -5],
        [168, 192, "c", -9],
      ].map(([x, y, path, delay]) => (
        <g key={path} transform={`translate(${x} ${y})`}>
          <g className={`hs-wisp hs-wisp-${path}`} style={{ animationDelay: `${delay}s` }}>
            <circle r="7" fill="url(#hs-wisp)" />
          </g>
        </g>
      ))}
    </g>
  );
}

/** Low fog in three bands. Feathered gradients, no blur filter. */
export function Fog() {
  return (
    <g className="hs-fog">
      <defs>
        <radialGradient id="hs-fog">
          <stop offset="0" stopColor="#b8a6e0" stopOpacity=".2" />
          <stop offset=".6" stopColor="#b8a6e0" stopOpacity=".08" />
          <stop offset="1" stopColor="#b8a6e0" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse className="hs-fog-a" cx="70" cy="214" rx="96" ry="10" fill="url(#hs-fog)" />
      <ellipse className="hs-fog-b" cx="190" cy="204" rx="84" ry="8" fill="url(#hs-fog)" />
      <ellipse className="hs-fog-c" cx="110" cy="250" rx="150" ry="12" fill="url(#hs-fog)" />
    </g>
  );
}

/** Film grain over the whole scene: static, so it is painted once. */
export function Grain() {
  return (
    <g className="hs-grain">
      <defs>
        <filter id="hs-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>
      <rect width={W} height={H} filter="url(#hs-grain)" opacity=".09" />
    </g>
  );
}
