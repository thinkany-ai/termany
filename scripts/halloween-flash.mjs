#!/usr/bin/env node
// Flash analysis for the Halloween scene, by the WCAG 2.3.1 definitions.
//
//   node --import tsx scripts/halloween-flash.mjs              sprite timelines (CI)
//   node --import tsx scripts/halloween-flash.mjs --video f.mp4  a recording (needs ffmpeg)
//
// Definitions used (WCAG 2.2, "general flash and red flash thresholds"):
// - A transition is a change in relative luminance of at least 0.1 where the
//   darker state is below 0.8. A general flash is a pair of opposing
//   transitions.
// - A red transition involves a saturated red (R/(R+G+B) >= 0.8) and changes
//   max(0, (R-G-B) x 320), on linear sRGB, by more than 20. A red flash is a
//   pair of them.
// - Content passes when no area flashes more than 3 times in any 1 s, OR the
//   area that does is at most 25% of a 10 degree field (341 x 256 px at
//   1024 x 768, the WCAG reference).
//
// Sprite timelines are composed from the committed sheets with the real
// player (apps/web/src/themes/halloween/player.ts), so they cover every
// frame the app can show, not one recording. This is a design check, not a
// replacement for PEAT; see docs/halloween/flash.md.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Director, showcasePose } from "../apps/web/src/themes/halloween/player.ts";
import { decodePng } from "./halloween-sprites.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHEETS = path.join(ROOT, "apps/web/src/themes/halloween/art/sheets");
const N1 = [17, 12, 24];

const lin = (c) => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const LIN = Array.from({ length: 256 }, (_, i) => lin(i));

/** Per pixel: [luminance, red value, saturated red?] of an RGB buffer. */
function measures(rgb, n) {
  const L = new Float32Array(n), red = new Float32Array(n), sat = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const R = LIN[r], G = LIN[g], B = LIN[b];
    L[i] = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    red[i] = Math.max(0, (R - G - B) * 320);
    sat[i] = r + g + b > 0 && r / (r + g + b) >= 0.8 ? 1 : 0;
  }
  return { L, red, sat };
}

/**
 * frames: [{ t (ms), rgb (Uint8Array, w*h*3) }], ordered, first at t=0.
 * areaPx: the pixel count that equals 25% of a 10 degree field.
 */
function analyze(frames, w, h, areaPx) {
  const n = w * h;
  const m = frames.map((f) => ({ t: f.t, ...measures(f.rgb, n) }));
  // Per pixel, the times of qualifying transitions, from the run of local extremes.
  const general = Array.from({ length: n }, () => []);
  const reds = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (const [series, out, ok] of [
      [m.map((f) => f.L[i]), general[i], (a, b) => Math.abs(a - b) >= 0.1 && Math.min(a, b) < 0.8],
      [m.map((f) => f.red[i]), reds[i], (a, b, j, k) => Math.abs(a - b) > 20 && (m[j].sat[i] || m[k].sat[i])],
    ]) {
      // Collapse to alternating extremes, then keep the qualifying steps.
      let ext = 0, dir = 0;
      for (let j = 1; j < series.length; j++) {
        const d = Math.sign(series[j] - series[j - 1]);
        if (d === 0) continue;
        if (dir !== 0 && d !== dir) {
          if (ok(series[ext], series[j - 1], ext, j - 1)) out.push(m[j - 1].t);
          ext = j - 1;
        }
        dir = d;
      }
      const last = series.length - 1;
      if (dir !== 0 && ok(series[ext], series[last], ext, last)) out.push(m[last].t);
    }
  }
  const worst = (lists) => {
    let maxFlashes = 0, worstWindowArea = 0;
    const end = frames[frames.length - 1].t;
    for (let start = 0; start <= Math.max(0, end - 1000); start += 50) {
      let area = 0;
      for (const times of lists) {
        let k = 0;
        for (const t of times) if (t >= start && t < start + 1000) k++;
        const flashes = Math.floor(k / 2);
        if (flashes > maxFlashes) maxFlashes = flashes;
        if (flashes > 3) area++;
      }
      if (area > worstWindowArea) worstWindowArea = area;
    }
    return { maxFlashes, worstWindowArea, pass: maxFlashes <= 3 || worstWindowArea <= areaPx };
  };
  return { general: worst(general), red: worst(reds) };
}

// --- sprite timelines ---------------------------------------------------------

function composer() {
  const load = (name) => {
    const json = JSON.parse(readFileSync(path.join(SHEETS, `${name}.json`), "utf8"));
    return { ...json, img: decodePng(readFileSync(path.join(SHEETS, `${name}.png`))) };
  };
  const s = Object.fromEntries(["backdrop", "pumpkin-flame", "pumpkin-pupils", "pumpkin-lids", "pumpkin-body", "wire", "bulb"].map((n) => [n, load(n)]));
  const W = 60, H = 64;
  const blit = (out, sheet, frame, dx, dy) => {
    const [w, h] = sheet.size, sx = sheet.frames[frame];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const X = dx + sheet.origin[0] + x, Y = dy + sheet.origin[1] + y;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const o = (y * sheet.img.width + sx + x) * 4;
      if (sheet.img.rgba[o + 3] === 0) continue;
      out.set(sheet.img.rgba.subarray(o, o + 3), (Y * W + X) * 3);
    }
  };
  const sheets = { flame: s["pumpkin-flame"], pupils: s["pumpkin-pupils"], lids: s["pumpkin-lids"], bulb: s.bulb };
  return {
    W, H, sheets,
    compose(p) {
      const out = new Uint8Array(W * H * 3);
      for (let i = 0; i < W * H; i++) out.set(N1, i * 3);
      [-6, 18, 42].forEach((x, i) => { blit(out, s.wire, "segment", x, 0); blit(out, s.bulb, p.bulbs[i], x, 0); });
      blit(out, s.backdrop, "night", 0, 16);
      blit(out, s["pumpkin-flame"], p.flame, 0, 16);
      blit(out, s["pumpkin-pupils"], p.pupils, 0, 16);
      blit(out, s["pumpkin-lids"], p.lids, 0, 16);
      blit(out, s["pumpkin-body"], "body", 0, 16);
      return out;
    },
  };
}

function timeline(c, poseAt, ms) {
  const frames = [];
  let last = "";
  for (let t = 0; t <= ms; t += 10) {
    const p = poseAt(t);
    const key = [p.flame, p.pupils, p.lids, ...p.bulbs].join();
    if (key !== last || t === ms) frames.push({ t, rgb: c.compose(p) });
    last = key;
  }
  return frames;
}

function spriteReport() {
  const c = composer();
  // One art pixel is 4 x 4 CSS px. The WCAG area limit is 25% of 341 x 256.
  const areaPx = Math.floor((0.25 * 341 * 256) / 16);
  const live = (moodAt, reduced = false) => {
    const d = new Director(c.sheets, 0);
    return (t) => d.pose(t, moodAt(t), moodAt(t) === "alert" ? "ur" : null, reduced);
  };
  const scenarios = {
    "idle, 120 s": live(() => "idle"),
    "alerts on and off, 120 s": live((t) => ((t / 1000) % 20 < 6 ? "alert" : "idle")),
    "rapid alerts every 1.2 s, 60 s": live((t) => (t % 1200 < 600 ? "alert" : "idle")),
    "reduced motion, 60 s": live(() => "idle", true),
    "share loop x3, 18 s": (t) => showcasePose(c.sheets, t),
  };
  const lengths = { "idle, 120 s": 120000, "alerts on and off, 120 s": 120000, "rapid alerts every 1.2 s, 60 s": 60000, "reduced motion, 60 s": 60000, "share loop x3, 18 s": 18000 };
  let ok = true;
  for (const [name, poseAt] of Object.entries(scenarios)) {
    const r = analyze(timeline(c, poseAt, lengths[name]), c.W, c.H, areaPx);
    ok &&= r.general.pass && r.red.pass;
    console.log(`${r.general.pass && r.red.pass ? "pass" : "FAIL"}  ${name}: max ${r.general.maxFlashes} general / ${r.red.maxFlashes} red flashes in any 1 s at any pixel; over-3 area ${r.general.worstWindowArea}/${areaPx} art px`);
  }
  return ok;
}

// --- a recording -----------------------------------------------------------------

function videoReport(file) {
  const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", file]).toString().trim().split(",");
  // Area-average down 6x: in the 1920x1080 share video one art pixel is a
  // 6x6 block, so this keeps every art pixel's luminance and is 36x lighter.
  const [w, h] = [Math.floor(Number(probe[0]) / 6), Math.floor(Number(probe[1]) / 6)];
  const [num, den] = probe[2].split("/").map(Number);
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${w}:${h}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 2 ** 31 - 1 });
  const size = w * h * 3, frames = [];
  for (let i = 0; i * size < raw.length; i++) frames.push({ t: (i * 1000 * den) / num, rgb: raw.subarray(i * size, (i + 1) * size) });
  // Shown full screen, 25% of a 10 degree field is this share of the frame.
  const areaPx = Math.floor(w * h * ((0.25 * 341 * 256) / (1024 * 768)));
  const r = analyze(frames, w, h, areaPx);
  console.log(`${r.general.pass && r.red.pass ? "pass" : "FAIL"}  ${path.basename(file)} (${w}x${h}, ${frames.length} frames): max ${r.general.maxFlashes} general / ${r.red.maxFlashes} red flashes in any 1 s; over-3 area ${r.general.worstWindowArea}/${areaPx} px`);
  return r.general.pass && r.red.pass;
}

/** The analyzer must fail a strobe and pass the same strobe when it is tiny. */
function selfTest() {
  const W = 60, H = 64, frames = [];
  const strobe = (lit) => (t) => {
    const rgb = new Uint8Array(W * H * 3);
    const on = Math.floor(t / 100) % 2 === 0;
    for (let i = 0; i < W * H; i++) if (on && lit(i)) rgb.fill(255, i * 3, i * 3 + 3);
    return rgb;
  };
  const run = (lit) => {
    frames.length = 0;
    for (let t = 0; t <= 2000; t += 100) frames.push({ t, rgb: strobe(lit)(t) });
    return analyze(frames, W, H, Math.floor((0.25 * 341 * 256) / 16));
  };
  const big = run(() => true), small = run((i) => i < 10);
  const ok = !big.general.pass && small.general.pass;
  console.log(`${ok ? "pass" : "FAIL"}  self-test: full-scene 5 Hz strobe ${big.general.pass ? "passed (wrong)" : "fails"}, 10-pixel strobe ${small.general.pass ? "passes" : "fails (wrong)"}`);
  return ok;
}

const i = process.argv.indexOf("--video");
const ok = i > 0 ? videoReport(process.argv[i + 1]) : selfTest() && spriteReport();
process.exit(ok ? 0 : 1);
