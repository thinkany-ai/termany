#!/usr/bin/env node
// Builds the Halloween sprite sheets from hand-placed pixel grids.
//
// Each source file in apps/web/src/themes/halloween/art/src/*.sprite holds
// one sprite: its size, its frames as character grids (one character = one
// art pixel, mapped 1:1 to a color in palette.gpl), and its sequences (tags)
// with a duration per step. This script only maps characters to colors and
// lays the frames side by side. It computes no shading and no in-betweens.
//
//   node scripts/halloween-sprites.mjs           build sheets + JSON
//   node scripts/halloween-sprites.mjs --check   audit only (CI), exit 1 on error
//
// The audit (--check) fails when a source uses a character outside the
// legend, when a committed sheet differs from what its source builds (someone
// edited a PNG by hand, or forgot to rebuild), or when any pixel of a
// committed sheet is half-transparent or not a palette color (PAL-1, PAL-2).
//
// Output, per sprite: art/sheets/<name>.png (frames in one row, 1 px per art
// pixel) and art/sheets/<name>.json ({ size, origin, frames: { name: x }, tags }).

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ART = join(ROOT, "apps/web/src/themes/halloween/art");

// One character per palette color. "." is a transparent pixel.
export const LEGEND = {
  "#": "N0", ":": "N1", ";": "N2", "=": "N3", "+": "N4", "*": "N5",
  q: "R0", w: "R1", e: "R2", r: "R3",
  a: "G0", s: "G1", d: "G2", f: "G3", g: "G4", h: "G5",
  z: "S0", x: "S1", c: "S2",
  p: "P1", P: "P2",
  u: "E0", i: "E1", o: "E2",
};

export function readPalette(file = join(ART, "palette.gpl")) {
  const pal = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/);
    if (m) pal[m[4]] = [+m[1], +m[2], +m[3]];
  }
  return pal;
}

/** Parse one .sprite file. Throws with file:line on any error. */
export function parseSprite(file) {
  const name = basename(file, ".sprite");
  const lines = readFileSync(file, "utf8").split("\n");
  let w = 0, h = 0;
  let origin = [0, 0];
  const frames = new Map();
  const tags = [];
  const fail = (i, msg) => { throw new Error(`${file}:${i + 1}: ${msg}`); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");
    if (!line || line.startsWith("//")) continue;
    const [word, ...rest] = line.split(/\s+/);
    if (word === "size") {
      const m = rest[0]?.match(/^(\d+)x(\d+)$/);
      if (!m) fail(i, "size must look like 44x40");
      w = +m[1]; h = +m[2];
    } else if (word === "origin") {
      // Where this layer sits in the scene it belongs to, in art pixels.
      if (rest.length !== 2 || !rest.every((v) => /^-?\d+$/.test(v))) fail(i, "origin needs two integers");
      origin = rest.map(Number);
    } else if (word === "frame") {
      if (!w) fail(i, "size must come before the first frame");
      const id = rest[0];
      if (!id || frames.has(id)) fail(i, `frame name missing or repeated: ${id}`);
      const rows = lines.slice(i + 1, i + 1 + h);
      rows.forEach((row, r) => {
        if (row.length !== w) fail(i + 1 + r, `row is ${row.length} wide, expected ${w}`);
        for (const ch of row) if (ch !== "." && !LEGEND[ch]) fail(i + 1 + r, `unknown pixel character "${ch}"`);
      });
      if (rows.length !== h) fail(i, `frame ${id} has ${rows.length} rows, expected ${h}`);
      frames.set(id, rows);
      i += h;
    } else if (word === "tag") {
      const [tagName, mode, ...steps] = rest;
      if (!["loop", "once"].includes(mode)) fail(i, "tag mode must be loop or once");
      tags.push({
        name: tagName,
        loop: mode === "loop",
        steps: steps.map((s) => {
          const [frame, ms] = s.split(":");
          if (!frames.has(frame)) fail(i, `tag ${tagName} uses unknown frame ${frame}`);
          if (!(+ms > 0)) fail(i, `step ${s} needs a duration in ms`);
          return { frame, ms: +ms };
        }),
      });
    } else {
      fail(i, `unknown directive "${word}"`);
    }
  }
  return { name, w, h, origin, frames, tags };
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width, height, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Decode an 8-bit RGBA or RGB, non-interlaced PNG (all this project writes or reads). */
export function decodePng(buf) {
  let p = 8, width = 0, height = 0, channels = 4;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0 || ![2, 6].includes(data[9])) throw new Error("unsupported PNG format");
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      cur[i] = (cur[i] + pred) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = cur[x * channels]; out[o + 1] = cur[x * channels + 1]; out[o + 2] = cur[x * channels + 2];
      out[o + 3] = channels === 4 ? cur[x * channels + 3] : 255;
    }
    cur.copy(prev);
  }
  return { width, height, rgba: out };
}

/** Every pixel fully transparent or fully opaque, and opaque ones in the palette. */
export function auditPixels({ width, height, rgba }, pal) {
  const allowed = new Set(Object.values(pal).map(([r, g, b]) => (r << 16) | (g << 8) | b));
  const problems = [];
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3];
    const rgb = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    if (a !== 0 && a !== 255) problems.push(`(${i % width},${Math.floor(i / width)}) alpha ${a}`);
    else if (a === 255 && !allowed.has(rgb)) problems.push(`(${i % width},${Math.floor(i / width)}) #${rgb.toString(16).padStart(6, "0")}`);
    if (problems.length >= 5) break;
  }
  return problems;
}

export function buildSheet(sprite, pal) {
  const ids = [...sprite.frames.keys()];
  const W = sprite.w * ids.length;
  const rgba = Buffer.alloc(W * sprite.h * 4);
  ids.forEach((id, f) => {
    sprite.frames.get(id).forEach((row, y) => {
      [...row].forEach((ch, x) => {
        if (ch === ".") return;
        const [r, g, b] = pal[LEGEND[ch]];
        const o = (y * W + f * sprite.w + x) * 4;
        rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
      });
    });
  });
  const json = {
    size: [sprite.w, sprite.h],
    origin: sprite.origin,
    frames: Object.fromEntries(ids.map((id, f) => [id, f * sprite.w])),
    tags: sprite.tags,
  };
  return { png: png(W, sprite.h, rgba), json };
}

function main() {
  const check = process.argv.includes("--check");
  const pal = readPalette();
  for (const ch of Object.values(LEGEND)) if (!pal[ch]) throw new Error(`legend color ${ch} is not in palette.gpl`);
  const srcDir = join(ART, "src");
  const outDir = join(ART, "sheets");
  mkdirSync(outDir, { recursive: true });
  let failed = false;
  for (const f of readdirSync(srcDir).filter((f) => f.endsWith(".sprite")).sort()) {
    try {
      const sprite = parseSprite(join(srcDir, f));
      const { png: buf, json } = buildSheet(sprite, pal);
      const jsonText = JSON.stringify(json, null, 1) + "\n";
      if (check) {
        const pngPath = join(outDir, `${sprite.name}.png`), jsonPath = join(outDir, `${sprite.name}.json`);
        const committed = decodePng(readFileSync(pngPath));
        const built = decodePng(buf);
        if (committed.width !== built.width || committed.height !== built.height || !committed.rgba.equals(built.rgba)) {
          throw new Error(`${pngPath}: does not match ${f}; run node scripts/halloween-sprites.mjs`);
        }
        if (readFileSync(jsonPath, "utf8") !== jsonText) throw new Error(`${jsonPath}: does not match ${f}`);
        const problems = auditPixels(committed, pal);
        if (problems.length) throw new Error(`${pngPath}: off-palette or half-transparent pixels: ${problems.join(", ")}`);
      } else {
        writeFileSync(join(outDir, `${sprite.name}.png`), buf);
        writeFileSync(join(outDir, `${sprite.name}.json`), jsonText);
      }
      console.log(`${check ? "ok" : "built"} ${sprite.name}: ${sprite.w}x${sprite.h}, ${sprite.frames.size} frames, ${sprite.tags.length} tags`);
    } catch (e) {
      failed = true;
      console.error(e.message);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
