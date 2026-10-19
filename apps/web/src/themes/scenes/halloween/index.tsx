import { useEffect, useRef } from "react";
import { attention, trackPointer } from "../../effects/halloween/attention";
import { EYE, GROUND, paint, PUMPKIN, SCALE, STILL, type Pose } from "./art";

/** Art rows the whole pumpkin needs, from the stem's tip to the bottom edge. */
const ROWS = GROUND + PUMPKIN.halfH * 2 + PUMPKIN.stem - 2;

// The pixel-art jack-o'-lantern at the foot of the sidebar (./art.ts). The
// grid is painted at art resolution and shown SCALE times larger with no
// smoothing; when the sidebar leaves less room than that needs, it steps down
// to 3× or 2× so the pumpkin is never cropped. The irises step a pixel at a time toward whatever attention.ts
// says to watch, and turn red while an agent works. The candle flickers. Frames are
// repainted only when something visible changes.

const TICK_MS = 80;

export default function HalloweenScene({ still = false }: { still?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = box.current!;
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    trackPointer();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 0;
    let H = 0;
    let scale = SCALE;
    let lastKey = "";
    let wander = { x: 0, y: 0, at: 0 };
    let timer = 0;

    const layout = () => {
      // Round up to an even width so the pumpkin's halves mirror exactly.
      // Leave a strip of sky above the stem for the fade at the top edge.
      scale = Math.max(2, Math.min(SCALE, Math.floor((host.clientHeight - 28) / ROWS)));
      W = Math.ceil(host.clientWidth / scale / 2) * 2;
      H = Math.ceil(host.clientHeight / scale);
      canvas.width = W;
      canvas.height = H;
      canvas.style.width = `${W * scale}px`;
      canvas.style.height = `${H * scale}px`;
      lastKey = "";
    };

    const pose = (now: number): Pose => {
      if (still) return STILL;
      const r = canvas.getBoundingClientRect();
      const ey = r.top + (H - GROUND - PUMPKIN.halfH + 1 + EYE.y + 0.5) * scale;
      const a = attention(now);
      if (!a.target && now > wander.at) {
        wander = { x: r.left + Math.random() * 900 - 100, y: r.top + Math.random() * 600 - 400, at: now + 800 + Math.random() * 2500 };
      }
      const { x: tx, y: ty } = a.target ?? wander;
      const look = (ex: number): [number, number] => {
        const dx = tx - ex;
        const dy = ty - ey;
        const d = Math.hypot(dx, dy) || 1;
        const reach = Math.min(1, d / 160);
        return [Math.round((dx / d) * reach * 2.4), Math.max(0, Math.min(1, Math.round((dy / d) * reach * 1.6)))];
      };
      const mid = r.left + (W / 2) * scale;
      const flick = reduced ? 1 : Math.sin(now / 130) + Math.sin(now / 47) > 1.2 ? 2 : Math.sin(now / 210) < -0.85 ? 0 : 1;
      return {
        left: look(mid - EYE.x * scale),
        right: look(mid + EYE.x * scale),
        pupil: a.busy ? 0 : Math.sin(now / 3000) > 0.3 ? 1 : 0,
        flame: flick as Pose["flame"],
        busy: a.busy,
      };
    };

    const draw = () => {
      if (!W || !H) return;
      const p = pose(performance.now());
      const key = JSON.stringify(p);
      if (key === lastKey) return;
      lastKey = key;
      const px = paint(W, H, p);
      const img = ctx.createImageData(W, H);
      for (let i = 0; i < px.length; i++) {
        const c = px[i];
        if (!c) continue;
        const v = parseInt(c.slice(1), 16);
        img.data[i * 4] = v >> 16;
        img.data[i * 4 + 1] = (v >> 8) & 255;
        img.data[i * 4 + 2] = v & 255;
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    };

    const observer = new ResizeObserver(() => {
      layout();
      draw();
    });
    observer.observe(host);
    layout();
    draw();
    if (!still) timer = window.setInterval(() => !document.hidden && draw(), TICK_MS);
    return () => {
      observer.disconnect();
      clearInterval(timer);
    };
  }, [still]);

  return (
    <div ref={box} className="pixel-scene" onMouseDown={(e) => e.preventDefault()}>
      <canvas ref={ref} aria-hidden="true" />
    </div>
  );
}
