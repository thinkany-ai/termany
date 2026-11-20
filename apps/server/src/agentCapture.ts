/**
 * What an agent printed, for agents whose own transcript Termany cannot read.
 *
 * Claude Code and Codex keep machine-readable transcripts; most other agent
 * CLIs keep theirs in private formats, or not at all. Every one of them draws
 * its conversation in the terminal, though, so while a recognized agent holds
 * a pane we keep its raw output. At handoff time it is replayed into a headless
 * terminal and read back as text — what the user saw on screen, which is what
 * a human taking over would read too.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import xtermHeadless from "@xterm/headless";

const { Terminal } = xtermHeadless as unknown as typeof import("@xterm/headless");

/** Raw bytes kept per capture; older output is dropped first. */
const MAX_RAW = 4 << 20;
const KEEP_FILES = 60;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function defaultCaptureDir(): string {
  return path.join(os.homedir(), ".termany", "captures");
}

interface Live {
  chunks: string[];
  bytes: number;
  /** Bytes appended since the last flush. */
  pending: string[];
  cols: number;
}

/** Captures being recorded, by segment id. Flushed to disk so they outlive the server. */
export class CaptureStore {
  private readonly live = new Map<string, Live>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly dir = defaultCaptureDir()) {}

  /** Where a capture is saved. */
  file(segmentId: string): string {
    return path.join(this.dir, `${segmentId}.log`);
  }

  start(segmentId: string, seed: string, cols: number): void {
    if (this.live.has(segmentId)) return;
    let existing = "";
    try {
      existing = fs.readFileSync(this.file(segmentId), "utf8");
    } catch {
      /* new capture */
    }
    const first = existing + seed;
    this.live.set(segmentId, { chunks: [first], bytes: first.length, pending: existing ? [seed] : [first], cols });
    this.schedule();
  }

  append(segmentId: string, data: string): void {
    const capture = this.live.get(segmentId);
    if (!capture) return;
    capture.chunks.push(data);
    capture.pending.push(data);
    capture.bytes += data.length;
    if (capture.bytes > MAX_RAW) {
      const all = capture.chunks.join("").slice(-Math.floor(MAX_RAW * 0.75));
      capture.chunks = [all];
      capture.bytes = all.length;
      capture.pending = [];
      this.rewrite(segmentId, all);
    }
    this.schedule();
  }

  resize(segmentId: string, cols: number): void {
    const capture = this.live.get(segmentId);
    if (capture && cols > 0) capture.cols = cols;
  }

  stop(segmentId: string): void {
    this.flush(segmentId);
    this.live.delete(segmentId);
  }

  /** Forget a capture entirely, live or saved. */
  discard(segmentId: string): void {
    this.live.delete(segmentId);
    try {
      fs.rmSync(this.file(segmentId), { force: true });
    } catch {
      /* already gone */
    }
  }

  isLive(segmentId: string): boolean {
    return this.live.has(segmentId);
  }

  /** Raw output so far (live or saved) and the width it was drawn at. */
  read(segmentId: string): { raw: string; cols: number } | null {
    const capture = this.live.get(segmentId);
    if (capture) return { raw: capture.chunks.join(""), cols: capture.cols };
    try {
      return { raw: fs.readFileSync(this.file(segmentId), "utf8"), cols: 120 };
    } catch {
      return null;
    }
  }

  flushAll(): void {
    for (const id of this.live.keys()) this.flush(id);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushAll();
    }, 3000);
    this.timer.unref();
  }

  private flush(segmentId: string): void {
    const capture = this.live.get(segmentId);
    if (!capture?.pending.length) return;
    const data = capture.pending.join("");
    capture.pending = [];
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.file(segmentId), data);
    } catch {
      /* best-effort */
    }
  }

  private rewrite(segmentId: string, data: string): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file(segmentId), data);
    } catch {
      /* best-effort */
    }
  }

  /** Drop old saved captures: beyond the newest KEEP_FILES, or older than MAX_AGE_MS. */
  prune(now = Date.now()): void {
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith(".log"))
        .map((f) => ({ f, id: f.slice(0, -4), at: fs.statSync(path.join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      files.forEach((file, i) => {
        if (this.live.has(file.id)) return;
        if (i >= KEEP_FILES || now - file.at > MAX_AGE_MS) fs.rmSync(path.join(this.dir, file.f), { force: true });
      });
    } catch {
      /* nothing saved yet */
    }
  }
}

const RULE_ONLY = /^[\s─━═│┃┄┅┈┉╌╍─—_\-=·•╭╮╯╰┌┐└┘├┤┬┴┼▔▁▏▕]*$/;

/** Screen text from raw terminal output: scrollback plus what is on screen, tidied. */
export async function renderCapture(raw: string, cols: number): Promise<string> {
  const term = new Terminal({ cols: Math.max(40, Math.min(cols || 120, 300)), rows: 50, scrollback: 20_000, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(raw, resolve));
  const read = (buffer: import("@xterm/headless").IBuffer) => {
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      // A soft-wrapped row continues the previous one.
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines;
  };
  const normal = read(term.buffer.normal);
  // A full-screen TUI draws on the alternate screen: its current screen is there.
  const alt = term.buffer.active.type === "alternate" ? read(term.buffer.alternate) : [];
  term.dispose();
  const tidy: string[] = [];
  for (const line of [...normal, ...(alt.length ? ["", "(current screen)", ...alt] : [])]) {
    const trimmed = line.replace(/\s+$/, "");
    if (RULE_ONLY.test(trimmed) && trimmed) continue;
    if (!trimmed && !tidy[tidy.length - 1]) continue;
    tidy.push(trimmed);
  }
  return tidy.join("\n").trim();
}
