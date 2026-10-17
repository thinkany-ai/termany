import {
  ridgeArt,
  batArt,
  BAT_SIZE,
  faceArt,
  farArt,
  farEmitArt,
  ghostArt,
  GHOST_SIZE,
  H,
  midArt,
  MOON,
  nearArt,
  owlHeadArt,
  OWL_HEAD_RECT,
  pumpkinArt,
  PUMPKIN_RECT,
  svg,
  W,
  witchArt,
  WITCH_SIZE,
} from "./art";
import { FRAGMENT, VERTEX } from "./shader";

/** The textures the shader samples, each drawn from one piece of SVG art. */
const TEXTURES = {
  uRidge: { w: W, h: H, art: ridgeArt },
  uFar: { w: W, h: H, art: farArt },
  uFarEmit: { w: W, h: H, art: farEmitArt },
  uMid: { w: W, h: H, art: midArt },
  uNear: { w: W, h: H, art: nearArt },
  uOwl: { w: OWL_HEAD_RECT.w, h: OWL_HEAD_RECT.h, art: owlHeadArt },
  uPumpkin: { w: PUMPKIN_RECT.w, h: PUMPKIN_RECT.h, art: pumpkinArt },
  uFaceA: { w: PUMPKIN_RECT.w, h: PUMPKIN_RECT.h, art: () => faceArt("calm") },
  uFaceB: { w: PUMPKIN_RECT.w, h: PUMPKIN_RECT.h, art: () => faceArt("cackle") },
  uGhost: { w: GHOST_SIZE.w, h: GHOST_SIZE.h, art: ghostArt },
  uBat: { w: BAT_SIZE.w * 2, h: BAT_SIZE.h, art: batArt },
  uWitch: { w: WITCH_SIZE.w, h: WITCH_SIZE.h, art: witchArt },
} as const;

type TextureName = keyof typeof TEXTURES;

/** Everything that changes from frame to frame. */
export type Frame = {
  time: number;
  flicker: number;
  windows: number;
  owlAngle: number;
  squash: [number, number];
  face: number;
  ghost: { x: number; y: number; alpha: number } | null;
  witch: { x: number; y: number; alpha: number } | null;
  bats: { x: number; y: number; scale: number; frame: number }[];
};

/** Draw one piece of art at `scale` px per unit into a canvas. */
async function rasterize(art: string, w: number, h: number, scale: number) {
  const pw = Math.max(1, Math.round(w * scale));
  const ph = Math.max(1, Math.round(h * scale));
  const img = new Image();
  // onload rather than decode(): decode() rejects SVG data URLs now and then.
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg(w, h, pw, ph, art))}`;
  });
  const canvas = document.createElement("canvas");
  canvas.width = pw;
  canvas.height = ph;
  canvas.getContext("2d")!.drawImage(img, 0, 0, pw, ph);
  return canvas;
}

/** Every texture's artwork at `scale` px per unit. */
export async function drawTextures(scale: number) {
  const names = Object.keys(TEXTURES) as TextureName[];
  const canvases = await Promise.all(
    names.map((n) => {
      const t = TEXTURES[n];
      // Sprites move and scale a little, so they get a little more detail.
      const s = t.w === W && t.h === H ? scale : scale * 1.4;
      return rasterize(t.art(), t.w, t.h, s);
    }),
  );
  return Object.fromEntries(names.map((n, i) => [n, canvases[i]])) as Record<TextureName, HTMLCanvasElement>;
}

/** How the W×H scene maps onto a canvas: centred, bottom-aligned, cropped to
 *  fill (the same as SVG's preserveAspectRatio="xMidYMax slice"). */
export function fit(width: number, height: number) {
  const scale = Math.max(width / W, height / H);
  return { scale, x: (width - W * scale) / 2, y: height - H * scale };
}

export class SceneRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private textures = new Map<TextureName, WebGLTexture>();
  private loc = new Map<string, WebGLUniformLocation | null>();

  /** Throws when WebGL2 is unavailable; the caller falls back to drawStatic. */
  constructor(canvas: HTMLCanvasElement, preserve: boolean) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: preserve,
      powerPreference: "low-power",
    });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link");
    this.program = program;
    this.vao = gl.createVertexArray()!;
    gl.useProgram(program);
    (Object.keys(TEXTURES) as TextureName[]).forEach((name, unit) => {
      const tex = gl.createTexture()!;
      this.textures.set(name, tex);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(this.u(name), unit);
    });
  }

  private u(name: string) {
    if (!this.loc.has(name)) this.loc.set(name, this.gl.getUniformLocation(this.program, name));
    return this.loc.get(name)!;
  }

  upload(canvases: Record<TextureName, HTMLCanvasElement>) {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    (Object.keys(TEXTURES) as TextureName[]).forEach((name, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.get(name)!);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvases[name]);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    });
  }

  draw(f: Frame) {
    const gl = this.gl;
    const { width, height } = gl.canvas as HTMLCanvasElement;
    const m = fit(width, height);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.u("uRes"), width, height);
    gl.uniform1f(this.u("uScale"), m.scale);
    gl.uniform2f(this.u("uOrigin"), m.x, m.y);
    gl.uniform1f(this.u("uTime"), f.time);
    gl.uniform1f(this.u("uFlicker"), f.flicker);
    gl.uniform1f(this.u("uWindows"), f.windows);
    const r = OWL_HEAD_RECT;
    gl.uniform4f(this.u("uOwlRect"), r.x, r.y, r.w, r.h);
    gl.uniform2f(this.u("uOwlPivot"), r.x + 11, r.y + 18);
    gl.uniform1f(this.u("uOwlAngle"), f.owlAngle);
    const p = PUMPKIN_RECT;
    gl.uniform4f(this.u("uPumpkinRect"), p.x, p.y, p.w, p.h);
    gl.uniform2f(this.u("uSquash"), f.squash[0], f.squash[1]);
    gl.uniform1f(this.u("uFace"), f.face);
    const g = f.ghost;
    gl.uniform4f(this.u("uGhostRect"), (g?.x ?? 0) - GHOST_SIZE.w / 2, (g?.y ?? 0) - GHOST_SIZE.h * 0.54, GHOST_SIZE.w, GHOST_SIZE.h);
    gl.uniform1f(this.u("uGhostAlpha"), g?.alpha ?? 0);
    const w = f.witch;
    gl.uniform4f(this.u("uWitchRect"), (w?.x ?? 0) - WITCH_SIZE.w / 2, (w?.y ?? 0) - WITCH_SIZE.h / 2, WITCH_SIZE.w, WITCH_SIZE.h);
    gl.uniform1f(this.u("uWitchAlpha"), w?.alpha ?? 0);
    const bats = new Float32Array(12);
    f.bats.slice(0, 3).forEach((b, i) => bats.set([b.x, b.y, b.scale, b.frame], i * 4));
    gl.uniform4fv(this.u("uBats[0]"), bats);
    gl.uniform2f(this.u("uBatSize"), BAT_SIZE.w, BAT_SIZE.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    const gl = this.gl;
    this.textures.forEach((t) => gl.deleteTexture(t));
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}

/** Without WebGL2: the artwork composited flat, over a plain sky and moon. */
export function drawStatic(canvas: HTMLCanvasElement, t: Record<TextureName, HTMLCanvasElement>) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const m = fit(canvas.width, canvas.height);
  ctx.save();
  ctx.translate(m.x, m.y);
  ctx.scale(m.scale, m.scale);
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#0c0816");
  sky.addColorStop(0.6, "#1e1232");
  sky.addColorStop(1, "#3a1c44");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  const halo = ctx.createRadialGradient(MOON.x, MOON.y, MOON.r, MOON.x, MOON.y, MOON.r * 2.6);
  halo.addColorStop(0, "rgba(255, 210, 150, 0.35)");
  halo.addColorStop(1, "rgba(255, 210, 150, 0)");
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#f6e6c8";
  ctx.beginPath();
  ctx.arc(MOON.x, MOON.y, MOON.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.drawImage(t.uFar, 0, 0, W, H);
  ctx.drawImage(t.uFarEmit, 0, 0, W, H);
  ctx.drawImage(t.uMid, 0, 0, W, H);
  const o = OWL_HEAD_RECT;
  ctx.drawImage(t.uOwl, o.x, o.y, o.w, o.h);
  ctx.drawImage(t.uNear, 0, 0, W, H);
  const p = PUMPKIN_RECT;
  ctx.drawImage(t.uPumpkin, p.x, p.y, p.w, p.h);
  ctx.drawImage(t.uFaceA, p.x, p.y, p.w, p.h);
  ctx.restore();
}
