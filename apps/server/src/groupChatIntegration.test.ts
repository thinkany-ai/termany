import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("group sessions isolate members and track each Bot's updated model without restarting", { timeout: 20_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-groups-"));
  const home = t.mock.method(os, "homedir", () => directory);
  const db = await import("./db.js");
  home.mock.restore();
  const { promptAcpRuntime, closeAllAcpRuntimes } = await import("./acpRuntime.js");
  t.after(async () => { closeAllAcpRuntimes(); await fs.rm(directory, { recursive: true, force: true }); });
  db.setAgentsRaw(JSON.stringify([{
    id: "test", name: "Test", command: process.execPath, args: "", enabled: true,
    runtime: { protocol: "acp", distribution: "custom", modelSource: "agent", command: process.execPath,
      args: JSON.stringify(fileURLToPath(new URL("../tests/fixtures/group-chat-acp.mjs", import.meta.url))) },
  }]));
  const turn = async (paneId: string, model: string) => {
    let text = "";
    await promptAcpRuntime({ paneId, agentId: "test", cwd: directory, config: { model }, prompt: "Group question",
      applySavedConfig: paneId.startsWith("group:"),
      botIdentity: { name: "Research bot", description: "Help research" }, signal: new AbortController().signal,
      emit: (event) => { if (event.type === "delta") text += event.text; } });
    return JSON.parse(text);
  };
  const privateReply = await turn("bot-one", "model-a");
  const first = await turn("group:one:bot:bot-one", "model-a");
  const second = await turn("group:one:bot:bot-two", "model-b");
  const anotherGroup = await turn("group:two:bot:bot-one", "model-a");
  assert.equal(new Set([privateReply.pid, first.pid, second.pid, anotherGroup.pid]).size, 4);
  const changed = await turn("group:one:bot:bot-one", "model-b");
  assert.equal(changed.pid, first.pid);
  assert.equal(changed.model, "model-b");
  assert.match(changed.prompt[0].text, /configuration reminder/);
  assert.match(changed.prompt[0].text, /Read current Bot configuration at .*runtime-profiles/);
  assert.equal((await turn("bot-one", "model-a")).model, "model-a");
  assert.equal((await turn("group:one:bot:bot-two", "model-b")).pid, second.pid);
});
