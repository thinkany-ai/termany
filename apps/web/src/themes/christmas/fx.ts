// The Christmas theme's moving overlay, drawn on one canvas over the window:
// falling snow and the odd shooting star (never over a terminal), and the
// firework that flies to a pane whose agent has finished; its embers settle on
// the snow on top of that pane. The route maths is pure, so it is tested in node.

export type Pt = [number, number];
export type Rect = { left: number; top: number; width: number; height: number };

/**
 * Waypoints for a rocket from `from` (the snowman's hand) to just above
 * `pane`. It flies along the gaps between surfaces: up the sidebar's right
 * edge, along the top bar, then down the gutter left of the pane, so it never
 * crosses a terminal. It bursts in the gap above the pane.
 */
export function rocketRoute(from: Pt, pane: Rect, layout: { sidebarRight: number; topBarBottom: number }): Pt[] {
  const lane = Math.max(12, layout.topBarBottom / 2);
  const side = Math.max(from[0] + 4, layout.sidebarRight - 14);
  const cx = pane.left + pane.width / 2;
  const pts: Pt[] = [from, [from[0] + 4, from[1] - 60], [side, Math.max(lane + 120, from[1] - 220)], [side, lane + 40], [side + 50, lane]];
  if (pane.top - layout.topBarBottom < 40) {
    pts.push([cx - 60, lane], [cx, lane + 4]);
  } else {
    const gx = pane.left - 5;
    pts.push([gx - 50, lane], [gx, lane + 40], [gx, pane.top - 40], [gx + 30, pane.top - 6], [cx, pane.top - 6]);
  }
  return pts;
}

type Path = { pts: Pt[]; len: number[]; total: number };

/** Catmull-Rom through the waypoints, with cumulative lengths for even speed. */
export function smoothPath(way: Pt[]): Path {
  const pts: Pt[] = [];
  for (let i = 0; i < way.length - 1; i++) {
    const p0 = way[Math.max(0, i - 1)], p1 = way[i], p2 = way[i + 1], p3 = way[Math.min(way.length - 1, i + 2)];
    for (let k = 0; k < 16; k++) {
      const t = k / 16, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      pts.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  pts.push(way[way.length - 1]);
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, len, total: len[len.length - 1] };
}

function pointAt(path: Path, d: number): Pt {
  let i = 1;
  while (i < path.len.length - 1 && path.len[i] < d) i++;
  const a = path.pts[i - 1], b = path.pts[i];
  const f = (d - path.len[i - 1]) / (path.len[i] - path.len[i - 1] || 1);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

const SPARK_COLORS = { gold: "255,200,110", red: "255,90,110", blue: "120,180,255", white: "255,250,240", green: "110,240,160" } as const;
type SparkColor = keyof typeof SPARK_COLORS;
const PALETTES: [SparkColor, SparkColor][] = [["gold", "red"], ["gold", "blue"], ["red", "white"], ["green", "gold"]];

type Flake = { x: number; y: number; z: number; ph: number };
type Rocket = { path: Path; d: number; speed: number; trail: Pt[]; palette: [SparkColor, SparkColor]; land?: Landing };
type Spark = { x: number; y: number; vx: number; vy: number; life: number; age: number; c: SparkColor; glitter: boolean; trail: Pt[] };
/** Where a burst's embers come to rest: the snow along a pane's top edge. */
export type Landing = { left: number; right: number; y: number };
type Ember = { x: number; y: number; vx: number; vy: number; age: number; life: number; c: SparkColor; land: Landing; landed: boolean };
type Meteor = { x: number; y: number; vx: number; vy: number; age: number; life: number };

export class Fx {
  private sprites = new Map<string, HTMLCanvasElement>();
  private flakes: Flake[] = [];
  private rockets: Rocket[] = [];
  private sparks: Spark[] = [];
  private flashes: { x: number; y: number; t: number }[] = [];
  private embers: Ember[] = [];
  private meteors: Meteor[] = [];
  private nextMeteor = 4 + Math.random() * 6;
  private launches = 0;
  private w = 0;
  private h = 0;

  constructor(private ctx: CanvasRenderingContext2D) {
    for (const [name, rgb] of Object.entries({ snow: "240,245,255", ...SPARK_COLORS })) this.sprites.set(name, sprite(rgb));
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    const n = Math.round(Math.min(320, (w * h) / 3600));
    while (this.flakes.length < n) this.flakes.push({ x: Math.random() * w, y: Math.random() * h, z: Math.random(), ph: Math.random() * 10 });
    this.flakes.length = n;
  }

  /** True while a rocket or its sparks are still in the air. */
  get busy(): boolean {
    return this.rockets.length + this.sparks.length + this.flashes.length + this.embers.length + this.meteors.length > 0;
  }

  /** Fires a rocket along `route`. Its embers settle on `land`, if given. */
  launch(route: Pt[], land?: Landing): void {
    this.rockets.push({ path: smoothPath(route), d: 0, speed: 0, trail: [], palette: PALETTES[this.launches++ % PALETTES.length], land });
  }

  /**
   * One frame. `snow` moves the flakes (false holds them still); `holes` are
   * the terminal panes, which snow never covers.
   */
  draw(dt: number, t: number, snow: boolean, holes: Rect[]): void {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    if (snow) {
      for (const f of this.flakes) {
        f.y += dt * (18 + f.z * 40);
        f.x += Math.sin(t * 0.6 + f.ph) * dt * (6 + f.z * 8);
        if (f.y > this.h + 5) { f.y = -5; f.x = Math.random() * this.w; }
      }
    }
    const flake = this.sprites.get("snow")!;
    for (const f of this.flakes) {
      const s = 2 + f.z * 4.5;
      ctx.globalAlpha = 0.3 + f.z * 0.5;
      ctx.drawImage(flake, f.x - s / 2, f.y - s / 2, s, s);
    }
    if (snow) {
      this.nextMeteor -= dt;
      if (this.nextMeteor <= 0) {
        this.nextMeteor = 7 + Math.random() * 12;
        // Start where the sky shows, not behind a terminal.
        for (let k = 0; k < 12; k++) {
          const x = this.w * Math.random(), y = this.h * (0.03 + Math.random() * 0.3);
          if (holes.some((r) => x > r.left - 20 && x < r.left + r.width + 20 && y > r.top - 20 && y < r.top + r.height)) continue;
          // Fall away from the terminals, steeply, so it stays in view.
          const dir = holes.some((r) => r.left > x) ? -1 : 1, a = (0.55 + Math.random() * 0.2) * Math.PI / 2, sp = 420 + Math.random() * 180;
          this.meteors.push({ x, y, vx: Math.cos(a) * sp * dir, vy: Math.sin(a) * sp, age: 0, life: 0.6 + Math.random() * 0.4 });
          break;
        }
      }
    }
    this.drawMeteors(dt);
    ctx.globalAlpha = 1;
    for (const r of holes) ctx.clearRect(r.left - 1, r.top + 4, r.width + 2, r.height - 3);

    // The firework goes over everything, once, when an agent finishes.
    ctx.globalCompositeOperation = "lighter";
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.speed = Math.min(1500, r.speed + dt * 2600);
      r.d = Math.min(r.path.total, r.d + r.speed * dt);
      const [x, y] = pointAt(r.path, r.d);
      r.trail.push([x, y]);
      if (r.trail.length > 30) r.trail.shift();
      r.trail.forEach(([tx, ty], j) => {
        const a = j / r.trail.length, s = 2 + a * 7;
        ctx.globalAlpha = a * 0.85;
        ctx.drawImage(this.sprites.get("gold")!, tx - s / 2, ty - s / 2, s, s);
      });
      ctx.globalAlpha = 1;
      ctx.drawImage(this.sprites.get("white")!, x - 9, y - 9, 18, 18);
      if (r.d >= r.path.total) {
        this.burst(x, y, r.palette, r.land);
        this.rockets.splice(i, 1);
      }
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      const s = 140 + f.t * 240;
      ctx.globalAlpha = Math.max(0, 1 - f.t / 0.5) * 0.7;
      ctx.drawImage(this.sprites.get("gold")!, f.x - s / 2, f.y - s / 2, s, s);
      if (f.t > 0.5) this.flashes.splice(i, 1);
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.age += dt;
      const drag = Math.pow(s.glitter ? 0.5 : 0.28, dt);
      s.vx *= drag;
      s.vy = s.vy * drag + 60 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.trail.push([s.x, s.y]);
      if (s.trail.length > 6) s.trail.shift();
      const life = 1 - s.age / s.life;
      if (life <= 0) { this.sparks.splice(i, 1); continue; }
      const tw = s.glitter ? (Math.sin(s.age * 40 + i) > 0 ? 1 : 0.2) : 1;
      s.trail.forEach(([tx, ty], j) => {
        const a = (j + 1) / s.trail.length, sz = (s.glitter ? 4 : 6) * (0.5 + a * 0.5);
        ctx.globalAlpha = life * life * a * tw;
        ctx.drawImage(this.sprites.get(s.c)!, tx - sz / 2, ty - sz / 2, sz, sz);
      });
    }
    this.drawEmbers(dt);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** A thin streak that fades in, crosses part of the sky and fades out. */
  private drawMeteors(dt: number): void {
    const { ctx } = this;
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.age += dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      const k = m.age / m.life;
      if (k >= 1) { this.meteors.splice(i, 1); continue; }
      const a = Math.sin(k * Math.PI), sp = Math.hypot(m.vx, m.vy), len = 70 + 90 * a;
      const tx = m.x - (m.vx / sp) * len, ty = m.y - (m.vy / sp) * len;
      const g = ctx.createLinearGradient(m.x, m.y, tx, ty);
      g.addColorStop(0, `rgba(255,250,235,${(0.95 * a).toFixed(3)})`);
      g.addColorStop(0.25, `rgba(190,215,255,${(0.45 * a).toFixed(3)})`);
      g.addColorStop(1, "rgba(150,180,255,0)");
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.globalAlpha = a;
      ctx.drawImage(this.sprites.get("white")!, m.x - 5, m.y - 5, 10, 10);
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /** Embers arc out of the burst, fall, and glow on the pane's snow a while. */
  private drawEmbers(dt: number): void {
    const { ctx } = this;
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i];
      e.age += dt;
      if (!e.landed) {
        e.vy += 260 * dt;
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        if (e.vy > 0 && e.y >= e.land.y) {
          if (e.x > e.land.left + 4 && e.x < e.land.right - 4) {
            e.landed = true;
            e.y = e.land.y - Math.random() * 2;
            e.age = 0;
          } else if (e.y > e.land.y + 40) e.age = e.life;
        }
      }
      if (e.age >= e.life) { this.embers.splice(i, 1); continue; }
      const k = e.age / e.life;
      const glow = e.landed ? (1 - k) * (0.7 + 0.3 * Math.sin(e.age * 9 + i)) : 1;
      const s = e.landed ? 6 + 5 * (1 - k) : 6;
      if (e.landed) {
        ctx.globalAlpha = glow * 0.5;
        ctx.drawImage(this.sprites.get(e.c)!, e.x - s * 1.8, e.y - s, s * 3.6, s * 2);
      }
      ctx.globalAlpha = glow;
      ctx.drawImage(this.sprites.get(e.c)!, e.x - s / 2, e.y - s / 2, s, s);
      ctx.drawImage(this.sprites.get("white")!, e.x - s / 4, e.y - s / 4, s / 2, s / 2);
    }
  }

  private burst(x: number, y: number, palette: [SparkColor, SparkColor], land?: Landing): void {
    this.flashes.push({ x, y, t: 0 });
    for (let i = 0; i < 170; i++) {
      const a = Math.random() * Math.PI * 2, sp = 140 + Math.random() * 230;
      this.sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.85, life: 1.6 + Math.random() * 0.8, age: 0, c: i % 7 === 0 ? "white" : palette[i % 2], glitter: false, trail: [] });
    }
    // A ring of slower glitter that hangs in the air.
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      this.sparks.push({ x, y, vx: Math.cos(a) * 95, vy: Math.sin(a) * 80, life: 2.6, age: 0, c: "white", glitter: true, trail: [] });
    }
    if (land) {
      for (let i = 0; i < 44; i++) {
        const dir = i % 2 ? 1 : -1;
        this.embers.push({ x, y, vx: dir * (20 + Math.random() * 200), vy: -(50 + Math.random() * 130), age: 0, life: 3 + Math.random() * 2, c: i % 5 === 0 ? "white" : palette[i % 2], land, landed: false });
      }
    }
  }
}

/** A soft round sprite in one colour. */
function sprite(rgb: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, `rgba(${rgb},1)`);
  gr.addColorStop(0.3, `rgba(${rgb},.6)`);
  gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 32);
  return c;
}
