import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentForProcess, splitArgs, type CatalogAgent } from "./agentCatalog.js";

const agent = (id: string, command: string, extra: Partial<CatalogAgent> = {}): CatalogAgent => ({
  id,
  name: id,
  command,
  installed: true,
  enabled: true,
  resumable: false,
  ...extra,
});

test("recognizes agents by program, by interpreted script, and by resolved path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"));
  try {
    const real = path.join(dir, "kimi-1.2.3");
    fs.writeFileSync(real, "");
    fs.symlinkSync(real, path.join(dir, "kimi"));
    const catalog = [
      agent("gemini", "gemini"),
      agent("cursor", "cursor-agent"),
      agent("kimi", "kimi", { path: path.join(dir, "kimi") }),
      agent("grok", "grok", { installed: false }),
    ];
    assert.equal(agentForProcess(["gemini", "--yolo"], catalog)?.id, "gemini");
    assert.equal(agentForProcess(["node", "--no-warnings", "/usr/local/lib/node_modules/@google/gemini-cli/dist/index.js"], catalog), null);
    assert.equal(agentForProcess(["node", "/Users/me/npm/bin/gemini", "-i", "x"], catalog)?.id, "gemini");
    assert.equal(agentForProcess(["/Users/me/.local/bin/cursor-agent"], catalog)?.id, "cursor");
    // Launched through a symlink to a versioned binary: argv[0] is the real file.
    assert.equal(agentForProcess([real], catalog)?.id, "kimi");
    // Not installed, or not an agent at all.
    assert.equal(agentForProcess(["grok"], catalog), null);
    assert.equal(agentForProcess(["vim", "notes.md"], catalog), null);
    assert.equal(agentForProcess([], catalog), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("splits ps args", () => {
  assert.deepEqual(splitArgs("  node /a/b/gemini  -i hi "), ["node", "/a/b/gemini", "-i", "hi"]);
});
