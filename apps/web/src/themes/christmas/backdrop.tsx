import { useEffect, useRef } from "react";
import { isDemo } from "../../demo";
import { subscribeAgentActivity } from "../../terminal/manager";
import { AgentWatch } from "../agent-watch";
import { buildScene, FORE, garland, HAND } from "./art";
import { Fx, rocketRoute } from "./fx";

// The Christmas theme behind and over the whole window:
//
// - behind everything, the hand-drawn snowy night (./art.ts), with the
//   foreground vignette anchored to the sidebar's bottom-left;
// - over everything, a string of lights across the top and one canvas for the
//   falling snow and fireworks (./fx.ts). Both ignore the pointer.
//
// When an agent in a pane finishes, that pane gets `data-xmas-waiting` (lit
// border, christmas.css), the root gets `data-xmas-alert` (the scene lights up),
// and a firework flies from the snowman's hand to the pane. Everything rests
// (CSS animations paused, no frames drawn) while the window is unfocused,
// hidden, or untouched for REST_AFTER_MS; reduced motion keeps it still.

/** Hold still after this long without input, as the Halloween scene does. */
const REST_AFTER_MS = 30_000;
/** Snow and fireworks are drawn at most this often. */
const FRAME_MS = 33;

export default function ChristmasBackdrop() {
  const sceneRef = useRef<HTMLDivElement>(null);
  const garlandRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const scene = sceneRef.current!;
    const garlandEl = garlandRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const fx = new Fx(ctx);
    const root = document.documentElement;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const watch = new AgentWatch();
    let fore: HTMLElement | null = null;
    let raf = 0;
    let last = 0;
    let t = 0;
    let lastInput = performance.now();
    let restTimer = 0;
    let scanTimer = 0;
    let disposed = false;

    const sidebarRect = () => document.querySelector(".sidebar")?.getBoundingClientRect() ?? null;
    const appRect = () => scene.getBoundingClientRect();

    // The vignette sits at the sidebar's bottom-left (or the window's, with the
    // sidebar hidden), and shrinks with a sidebar narrower than it.
    let foreScale = 1;
    const anchor = () => {
      if (!fore) return;
      const app = appRect(), sb = sidebarRect();
      foreScale = sb ? Math.min(1, sb.width / FORE.w) : 1;
      fore.style.left = `${sb ? sb.left - app.left : 0}px`;
      fore.style.transform = foreScale < 1 ? `scale(${foreScale.toFixed(3)})` : "";
    };

    const build = () => {
      const { width: W, height: H } = appRect();
      if (!W || !H) return;
      const art = buildScene(Math.round(W), Math.round(H));
      scene.innerHTML =
        art.layers.map((l) => `<div class="xmas-layer xmas-${l.name}">${l.svg}</div>`).join("") +
        `<div class="xmas-layer xmas-fore" style="width:${FORE.w}px;height:${FORE.h}px">${art.fore}</div>`;
      fore = scene.querySelector(".xmas-fore");
      anchor();
      garlandEl.innerHTML = garland(Math.round(W));
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fx.resize(W, H);
      wake();
    };

    const resting = () => document.hidden || (!isDemo && !document.hasFocus()) || performance.now() - lastInput >= REST_AFTER_MS;

    const frame = (now: number) => {
      raf = 0;
      if (disposed) return;
      const still = reduced.matches;
      const rest = resting();
      root.classList.toggle("xmas-rest", rest);
      if (rest && !fx.busy) return;
      raf = requestAnimationFrame(frame);
      if (now - last < FRAME_MS) return;
      const dt = Math.min((now - (last || now)) / 1000, 0.1);
      last = now;
      if (!still) t += dt;
      const app = appRect();
      const holes = [...document.querySelectorAll<HTMLElement>(".pane-slot")].map((p) => {
        const r = p.getBoundingClientRect();
        return { left: r.left - app.left, top: r.top - app.top, width: r.width, height: r.height };
      });
      fx.draw(dt, t, !still && !rest, holes);
    };

    const wake = () => {
      if (!raf && !disposed) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
      window.clearTimeout(restTimer);
      // Look again when the rest timer runs out, so the CSS animations pause too.
      restTimer = window.setTimeout(() => wake(), REST_AFTER_MS + 50);
    };

    const onInput = () => {
      lastInput = performance.now();
      wake();
      // A click or key may have focused a waiting pane.
      window.clearTimeout(scanTimer);
      scanTimer = window.setTimeout(scan, 120);
    };

    const scan = () => {
      if (disposed) return;
      const { waiting } = watch.scan();
      const ids = new Set(waiting.map((p) => p.dataset.paneId));
      for (const el of document.querySelectorAll<HTMLElement>(".pane-slot[data-xmas-waiting]")) {
        if (!ids.has(el.dataset.paneId)) el.removeAttribute("data-xmas-waiting");
      }
      for (const pane of waiting) {
        if (pane.hasAttribute("data-xmas-waiting")) continue;
        pane.setAttribute("data-xmas-waiting", "");
        if (!reduced.matches) launchAt(pane);
      }
      root.toggleAttribute("data-xmas-alert", waiting.length > 0);
      anchor();
    };

    const launchAt = (pane: HTMLElement) => {
      if (!fore) return;
      const app = appRect();
      const f = fore.getBoundingClientRect();
      const p = pane.getBoundingClientRect();
      const top = document.querySelector(".htabbar")?.getBoundingClientRect();
      const sb = sidebarRect();
      const route = rocketRoute(
        [f.left - app.left + HAND[0] * foreScale, f.top - app.top + HAND[1] * foreScale],
        { left: p.left - app.left, top: p.top - app.top, width: p.width, height: p.height },
        { sidebarRight: sb ? sb.right - app.left : 0, topBarBottom: top ? top.bottom - app.top : 36 },
      );
      fx.launch(route);
      wake();
    };

    let resizeTimer = 0;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(build, 150);
    };
    // The sidebar can be resized or hidden without a window resize.
    const main = document.querySelector(".main");
    const ro = new ResizeObserver(anchor);
    if (main) ro.observe(main);

    build();
    scan();
    const unsubscribe = subscribeAgentActivity(scan);
    window.addEventListener("resize", onResize);
    window.addEventListener("focus", onInput);
    window.addEventListener("blur", wake);
    document.addEventListener("visibilitychange", wake);
    for (const type of ["keydown", "pointerdown", "pointermove", "wheel"] as const) {
      window.addEventListener(type, onInput, { capture: true, passive: true });
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(restTimer);
      window.clearTimeout(scanTimer);
      window.clearTimeout(resizeTimer);
      unsubscribe();
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("focus", onInput);
      window.removeEventListener("blur", wake);
      document.removeEventListener("visibilitychange", wake);
      for (const type of ["keydown", "pointerdown", "pointermove", "wheel"] as const) {
        window.removeEventListener(type, onInput, { capture: true });
      }
      for (const el of document.querySelectorAll(".pane-slot[data-xmas-waiting]")) el.removeAttribute("data-xmas-waiting");
      root.removeAttribute("data-xmas-alert");
      root.classList.remove("xmas-rest");
    };
  }, []);

  return (
    <>
      <div ref={sceneRef} className="xmas-backdrop" aria-hidden="true" />
      <div ref={garlandRef} className="xmas-garland" aria-hidden="true" />
      <canvas ref={canvasRef} className="xmas-fx" aria-hidden="true" />
    </>
  );
}
