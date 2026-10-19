#!/usr/bin/env node
// Exports the Halloween share frame (candidate A) from the demo build, the
// same pixels every run.
//
//   (cd apps/web && VITE_DEMO=1 npx vite --port 15173)      # in another shell
//   node --import tsx scripts/halloween-showcase.mjs          # PNG at 2.5 s
//   node --import tsx scripts/halloween-showcase.mjs --at 0   # PNG at 0 s
//   node --import tsx scripts/halloween-showcase.mjs --video  # 6 s MP4
//   ... --at 500 --out blind-test/a3.png                       # another moment, another name
//
// The page is 1280x720 CSS px at device pixel ratio 1.5, so the output is
// exactly 1920x1080 and one art pixel is exactly 6 device pixels (PX-1).
// `?showcase=<ms>` freezes the scripted 6 s loop (themes/halloween/player.ts)
// and opens the agent panes on real captured Claude Code and Codex screens.
//
// For the video, every distinct pose is rendered once and ffmpeg holds it for
// its exact duration, so the MP4 has no capture jitter. Needs Chrome and
// ffmpeg; CHROME and FFMPEG override the binaries, URL the demo address.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHOWCASE_MS, showcasePose } from "../apps/web/src/themes/halloween/player.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs/halloween");
const URL = process.env.URL ?? "http://localhost:15173";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

function shoot(ms, file) {
  const profile = mkdtempSync(path.join(os.tmpdir(), "halloween-chrome-"));
  try {
    execFileSync(CHROME, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--user-data-dir=${profile}`,
      "--window-size=1280,720",
      "--force-device-scale-factor=1.5",
      "--virtual-time-budget=4000",
      `--screenshot=${file}`,
      `${URL}/?theme=halloween&showcase=${ms}`,
    ], { stdio: "ignore" });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

const sheet = (name) =>
  JSON.parse(readFileSync(path.join(ROOT, `apps/web/src/themes/halloween/art/sheets/${name}.json`), "utf8"));
const sheets = { flame: sheet("pumpkin-flame"), pupils: sheet("pumpkin-pupils"), lids: sheet("pumpkin-lids"), bulb: sheet("bulb") };

mkdirSync(OUT, { recursive: true });

if (args.includes("--video")) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "halloween-frames-"));
  const list = [];
  for (let t = 0; t < SHOWCASE_MS; ) {
    const { next } = showcasePose(sheets, t);
    const hold = Math.min(next, SHOWCASE_MS - t);
    const file = path.join(dir, `${String(t).padStart(5, "0")}.png`);
    shoot(t, file);
    list.push(`file '${file}'\nduration ${(hold / 1000).toFixed(3)}`);
    process.stdout.write(`pose at ${t} ms, held ${hold} ms\n`);
    t += hold;
  }
  // The concat demuxer needs the last file repeated to honour its duration.
  list.push(list[list.length - 1].split("\n")[0]);
  writeFileSync(path.join(dir, "list.txt"), list.join("\n") + "\n");
  const mp4 = path.join(OUT, "showcase.mp4");
  execFileSync(FFMPEG, [
    "-y", "-f", "concat", "-safe", "0", "-i", path.join(dir, "list.txt"),
    "-t", String(SHOWCASE_MS / 1000), "-vf", "fps=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-movflags", "+faststart", mp4,
  ], { stdio: "ignore" });
  rmSync(dir, { recursive: true, force: true });
  console.log(`wrote ${path.relative(ROOT, mp4)}`);
} else {
  const ms = Number(opt("--at", "2500"));
  const file = path.join(OUT, opt("--out", `showcase-${ms}.png`));
  shoot(ms, file);
  console.log(`wrote ${path.relative(ROOT, file)}`);
}
