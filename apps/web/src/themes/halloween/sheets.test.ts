import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { inflateSync } from "node:zlib";

// The sheets are the source (edit them in Aseprite with palette.gpl loaded).
// Every pixel must be fully opaque or fully transparent, and every opaque
// pixel one of the 24 palette colors (art/README.md, PAL-1 and PAL-2).

const art = new URL("./art/", import.meta.url);
const palette = new Set(
  readFileSync(new URL("palette.gpl", art), "utf8")
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+\S+/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => (Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3])),
);

/** Pixels of an 8-bit RGBA, non-interlaced PNG. */
function rgba(buf: Buffer): { width: number; pixels: Buffer } {
  assert.equal(buf[25], 6, "sheets must be 8-bit RGBA");
  const width = buf.readUInt32BE(16);
  const idat: Buffer[] = [];
  for (let p = 8; p < buf.length; ) {
    const len = buf.readUInt32BE(p);
    if (buf.toString("ascii", p + 4, p + 8) === "IDAT") idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(raw.length - raw.length / (stride + 1));
  for (let y = 0, prev = Buffer.alloc(stride); y * (stride + 1) < raw.length; y++) {
    const f = raw[y * (stride + 1)];
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? row[i - 4] : 0, b = prev[i], c = i >= 4 ? prev[i - 4] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      row[i] += [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
    }
    row.copy(out, y * stride);
    prev = row;
  }
  return { width, pixels: out };
}

for (const file of readdirSync(new URL("sheets/", art)).filter((f) => f.endsWith(".png"))) {
  test(`${file}: only palette colors, no partial alpha`, () => {
    const { width, pixels } = rgba(readFileSync(new URL(`sheets/${file}`, art)));
    for (let i = 0; i < pixels.length; i += 4) {
      const at = `(${(i / 4) % width},${Math.floor(i / 4 / width)})`;
      const alpha = pixels[i + 3];
      assert.ok(alpha === 0 || alpha === 255, `${at} has alpha ${alpha}`);
      const rgb = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
      if (alpha === 255) assert.ok(palette.has(rgb), `${at} is #${rgb.toString(16).padStart(6, "0")}, not in the palette`);
    }
  });
}
