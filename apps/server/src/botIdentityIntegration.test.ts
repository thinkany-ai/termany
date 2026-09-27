import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { BotIdentity, BotSkillBinding } from "@termany/core";

test("Bot identity reaches both provider formats and a reused ACP session", { timeout: 30_000 }, async (t) => {
  // db.ts initializes at import time. Redirect its directory before loading it
  // so this test never opens or changes the user's model/agent configuration.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-bot-identity-"));
  const homeMock = t.mock.method(os, "homedir", () => directory);
  const db = await import("./db.js");
  const { getSkillRepository } = await import("./skills.js");
  const skills = await getSkillRepository();
  homeMock.mock.restore();
  const { streamAgentChat } = await import("./agentChat.js");
  const { promptAcpRuntime, closeAcpRuntimes, reapIdleAcpRuntimes } = await import("./acpRuntime.js");
  t.after(() => {
    closeAcpRuntimes(["identity-pane"]);
    return fs.rm(directory, { recursive: true, force: true });
  });

  const bindings: Record<string, BotSkillBinding> = {};
  for (const name of ["musk", "jobs"]) {
    const source = path.join(directory, name);
    await fs.mkdir(path.join(source, "references"), { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} framework\n---\n# ${name} framework\nUse the ${name} decision process.\n`);
    await fs.writeFile(path.join(source, "references", "private.md"), "Only read this resource on demand.");
    const job = skills.startImport({ source: { kind: "local", path: source } });
    while (skills.getImport(job.id).status === "running") await new Promise(resolve => setTimeout(resolve, 5));
    const result = skills.getImport(job.id);
    assert.equal(result.status, "complete", result.error ?? "");
    bindings[name] = result.binding!;
  }

  const messages = [{ role: "user" as const, content: "Who are you?" }];
  for (const kind of ["openai", "anthropic"] as const) {
    await t.test(`${kind} receives current Bot metadata in its system prompt`, async (t) => {
      db.setModelsRaw(JSON.stringify({ providers: [{
        id: "test", kind, name: "Test provider", apiBase: "https://model.invalid",
        apiKey: "test-key", models: ["test-model"],
      }], defaultModel: "test/test-model" }));
      const requests: Record<string, any>[] = [];
      t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        const event = kind === "anthropic"
          ? { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } }
          : { choices: [{ delta: { content: "hello" } }] };
        return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
      });
      let reply = "";
      await streamAgentChat(undefined, messages, new AbortController().signal, (text) => { reply += text; }, {
        name: "Research bot", description: "Research markets",
      });
      await streamAgentChat(undefined, messages, new AbortController().signal, () => {}, {
        name: "Writing bot", description: "",
      });
      await streamAgentChat(undefined, messages, new AbortController().signal, () => {});
      const imagePath = path.join(directory, `${kind}.png`);
      await fs.writeFile(imagePath, Buffer.from(`${kind} image`));
      await streamAgentChat(undefined, [{ role: "user", content: "Describe this", images: [{ path: imagePath }] }],
        new AbortController().signal, () => {});
      assert.equal(reply, "hello");
      const systems = requests.map((request) => kind === "anthropic" ? request.system : request.messages[0].content);
      assert.match(systems[0], /Research bot/);
      assert.match(systems[0], /Research markets/);
      assert.match(systems[1], /Writing bot/);
      assert.ok(systems[1].includes('"description":""'));
      assert.doesNotMatch(systems[1], /Research bot|Research markets/);
      assert.doesNotMatch(systems[2], /Current Bot profile/);
      for (const request of requests.slice(0, 3)) {
        assert.equal(request.model, "test-model");
        assert.deepEqual(kind === "anthropic" ? request.messages : request.messages.slice(1), messages);
      }
      const imageContent = kind === "anthropic" ? requests[3].messages[0].content : requests[3].messages[1].content;
      assert.equal(imageContent[0].type, "text");
      const imageBlock = imageContent.find((item: { type: string }) => item.type === (kind === "anthropic" ? "image" : "image_url"));
      assert.ok(imageBlock);
      if (kind === "anthropic") {
        assert.equal(imageBlock.source.media_type, "image/png");
        assert.equal(imageBlock.source.data, Buffer.from(`${kind} image`).toString("base64"));
      } else {
        assert.equal(imageBlock.image_url.url, `data:image/png;base64,${Buffer.from(`${kind} image`).toString("base64")}`);
      }
      await streamAgentChat(undefined, messages, new AbortController().signal, () => {}, {
        name: "Musk", instructions: "Answer in Chinese", skills: [bindings.musk],
      });
      await streamAgentChat(undefined, messages, new AbortController().signal, () => {}, {
        name: "Jobs", skills: [bindings.jobs],
      });
      await streamAgentChat(undefined, messages, new AbortController().signal, () => {}, {
        name: "Musk", instructions: "", skills: [],
      });
      const systemAt = (index: number) => kind === "anthropic" ? requests[index].system : requests[index].messages[0].content;
      assert.match(systemAt(4), /musk framework/);
      assert.match(systemAt(4), /Answer in Chinese/);
      assert.match(systemAt(4), /"entry": ".*SKILL\.md"/);
      assert.match(systemAt(4), /Read each absolute entry path using your file tools/);
      assert.doesNotMatch(systemAt(4), /# jobs framework|Use the musk decision process|Only read this resource|read_skill/);
      assert.match(systemAt(5), /jobs framework/);
      assert.doesNotMatch(systemAt(5), /musk framework/);
      assert.match(systemAt(6), /Bound Skills: none/);
      assert.doesNotMatch(systemAt(6), /# musk framework|Answer in Chinese/);
    });
  }

  await t.test("ACP keeps one session while applying renames and cleared descriptions", async () => {
    db.setAgentsRaw(JSON.stringify([{
      id: "identity-test-agent", name: "Test agent", command: process.execPath, args: "", enabled: true,
      runtime: {
        protocol: "acp", distribution: "custom", modelSource: "agent", command: process.execPath,
        args: JSON.stringify(fileURLToPath(new URL("../tests/fixtures/bot-identity-acp.mjs", import.meta.url))),
      },
    }]));
    const turn = async (botIdentity?: BotIdentity, images?: { path: string }[], prompt = "Who are you?") => {
      let reply = "";
      await promptAcpRuntime({
        paneId: "identity-pane", agentId: "identity-test-agent", cwd: directory,
        prompt, images, botIdentity, signal: new AbortController().signal,
        emit: (event) => { if (event.type === "delta") reply += event.text; },
      });
      return JSON.parse(reply) as { prompt: { type: string; text?: string; data?: string; mimeType?: string }[]; pid: number; mcpServers?: unknown[] };
    };
    const first = await turn({ name: "Research bot", description: "Research markets" });
    const renamed = await turn({ name: "Writing bot", description: "" });
    assert.equal(first.pid, renamed.pid, "editing a Bot must not restart its conversation");
    assert.match(first.prompt[0].text!, /Research bot/);
    assert.match(first.prompt[0].text!, /Research markets/);
    assert.match(renamed.prompt[0].text!, /Writing bot/);
    assert.ok(renamed.prompt[0].text!.includes('"description":""'));
    assert.deepEqual(renamed.prompt[1], { type: "text", text: "Who are you?" });
    assert.doesNotMatch(renamed.prompt[0].text!, /Research bot|Research markets/);
    const plain = await turn();
    assert.deepEqual(plain.prompt, [{ type: "text", text: "Who are you?" }]);
    const imagePath = path.join(directory, "pasted.png");
    await fs.writeFile(imagePath, Buffer.from("image bytes"));
    const pictured = await turn(undefined, [{ path: imagePath }]);
    assert.deepEqual(pictured.prompt[0], { type: "text", text: "Who are you?" });
    assert.equal(pictured.prompt[1].type, "image");
    assert.equal(pictured.prompt[1].mimeType, "image/png");
    assert.equal(pictured.prompt[1].data, Buffer.from("image bytes").toString("base64"));
    const bound = await turn({ name: "Musk", instructions: "Focus on costs", skills: [bindings.musk] });
    assert.match(bound.prompt[0].text!, /musk framework/);
    assert.match(bound.prompt[0].text!, /"entry": ".*SKILL\.md"/);
    assert.match(bound.prompt[0].text!, /Read each absolute entry path using your file tools/);
    assert.doesNotMatch(bound.prompt[0].text!, /Use the musk decision process/);
    assert.deepEqual(bound.mcpServers ?? [], []);
    const repeated = await turn({ name: "Musk", instructions: "Focus on costs", skills: [bindings.musk] });
    assert.match(repeated.prompt[0].text!, /configuration reminder/);
    assert.doesNotMatch(repeated.prompt[0].text!, /Focus on costs/);
    reapIdleAcpRuntimes(Date.now() + 10 * 60 * 1000);
    const resumed = await turn({ name: "Musk", instructions: "Focus on costs", skills: [bindings.musk] });
    assert.notEqual(resumed.pid, repeated.pid);
    assert.match(resumed.prompt[0].text!, /Focus on costs/);
    assert.match(bound.prompt[0].text!, /Focus on costs/);
    assert.doesNotMatch(bound.prompt[0].text!, /read_skill|get_bot_profile/);
    assert.doesNotMatch(bound.prompt[0].text!, /Only read this resource/);
    const changed = await turn({ name: "Jobs", instructions: "", skills: [bindings.jobs] });
    assert.equal(resumed.pid, changed.pid);
    assert.match(changed.prompt[0].text!, /jobs framework/);
    assert.doesNotMatch(changed.prompt[0].text!, /# musk framework|Focus on costs/);
    const cleared = await turn({ name: "Jobs", instructions: "", skills: [] });
    assert.equal(cleared.pid, resumed.pid);
    assert.match(cleared.prompt[0].text!, /Bound Skills: none/);
    const command = await turn({ name: "Broken", skills: [{ skillId: "missing", revision: "invalid" }] }, undefined, "/compact");
    assert.deepEqual(command.prompt, [{ type: "text", text: "/compact" }]);
  });
});
