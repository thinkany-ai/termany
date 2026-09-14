import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AcpRuntimeEvent } from './acpRuntime.js';

test('ACP idle lifecycle preserves context and prevents duplicate/orphan startups', { timeout: 30_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'termany-idle-acp-'));
  const home = t.mock.method(os, 'homedir', () => directory);
  const db = await import('./db.js');
  home.mock.restore();
  const runtime = await import('./acpRuntime.js');
  t.after(async () => { runtime.closeAllAcpRuntimes(); await fs.rm(directory, { recursive: true, force: true }); });
  const fixture = fileURLToPath(new URL('../tests/fixtures/idle-acp.mjs', import.meta.url));
  db.setAgentsRaw(JSON.stringify(['load', 'no-load', 'fail-load'].map((id) => ({
    id, name: id, command: process.execPath, args: '', enabled: true,
    runtime: { protocol: 'acp', distribution: 'custom', modelSource: 'agent', command: process.execPath,
      args: `${JSON.stringify(fixture)} ${id}` },
  }))));
  const target = (paneId: string, agentId = 'load') => ({ paneId, agentId, cwd: directory });
  const transcript = async () => (await fs.readFile(path.join(directory, 'idle-transcript.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const prompt = async (paneId: string, agentId = 'load') => {
    const events: AcpRuntimeEvent[] = [];
    await runtime.promptAcpRuntime({ ...target(paneId, agentId), prompt: 'Hello', signal: new AbortController().signal,
      emit: (event) => {
        events.push(event);
        if (event.type === 'permission') {
          // Even an expired idle deadline must not interrupt an active turn.
          runtime.reapIdleAcpRuntimes(Date.now() + 600_000);
          assert.equal(runtime.respondAcpPermission(paneId, event.requestId, 'allow'), true);
        }
      } });
    return { reply: JSON.parse(events.filter((e) => e.type === 'delta').map((e) => e.text).join('')),
      sessionId: events.find((e) => e.type === 'done')!.sessionId };
  };

  await Promise.all(Array.from({ length: 5 }, () => runtime.loadAcpRuntimeConfig(target('shared'))));
  assert.equal((await transcript()).filter((m) => m.method === 'initialize').length, 1);
  await runtime.setAcpConfigOption({ ...target('shared'), configId: 'model', value: 'other' });
  const first = await prompt('shared');
  runtime.reapIdleAcpRuntimes();
  assert.equal((await prompt('shared')).reply.pid, first.reply.pid, 'recent sessions stay warm');
  runtime.reapIdleAcpRuntimes(Date.now() + 600_000);
  const alive = () => { try { process.kill(first.reply.pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 3_000;
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(alive(), false, 'idle eviction actually releases the agent process');
  assert.equal(runtime.acpRuntimeCwd('shared'), directory);
  assert.equal(runtime.acpRuntimeConfig(target('shared'))?.[0].currentValue, 'other');
  const second = await prompt('shared');
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.reply.turns, 3);
  assert.equal(second.reply.model, 'other');
  assert.notEqual(second.reply.pid, first.reply.pid);
  assert.equal((await transcript()).filter((m) => m.method === 'session/new').length, 1);

  runtime.reapIdleAcpRuntimes(Date.now() + 600_000);
  const beforePicker = (await transcript()).filter((m) => m.method === 'initialize').length;
  await runtime.setAcpConfigOption({ ...target('shared'), configId: 'model', value: 'default' });
  assert.equal((await transcript()).filter((m) => m.method === 'initialize').length, beforePicker, 'sleeping model picker does not boot a process');
  assert.equal((await prompt('shared')).reply.model, 'default');

  const retained = await prompt('retained', 'no-load');
  runtime.reapIdleAcpRuntimes(Date.now() + 600_000);
  assert.equal((await prompt('retained', 'no-load')).reply.pid, retained.reply.pid);

  await runtime.loadAcpRuntimeConfig(target('probe', 'no-load'));
  const before = (await transcript()).filter((m) => m.method === 'initialize').length;
  runtime.reapIdleAcpRuntimes(Date.now() + 600_000);
  await runtime.loadAcpRuntimeConfig(target('probe', 'no-load'));
  assert.equal((await transcript()).filter((m) => m.method === 'initialize').length, before + 1);

  await prompt('failure', 'fail-load');
  runtime.reapIdleAcpRuntimes(Date.now() + 600_000);
  const newCount = (await transcript()).filter((m) => m.method === 'session/new').length;
  await assert.rejects(prompt('failure', 'fail-load'), /Cannot load saved session/);
  assert.equal((await transcript()).filter((m) => m.method === 'session/new').length, newCount, 'load failure must never silently reset context');

  const startup = runtime.loadAcpRuntimeConfig(target('closed'));
  runtime.closeAcpRuntimes(['closed']);
  await assert.rejects(startup, /closed during startup/);
  assert.equal(runtime.acpRuntimeCwd('closed'), undefined);

  runtime.closeAcpRuntimes(['shared']);
  assert.equal(runtime.acpRuntimeCwd('shared'), undefined);
  assert.equal((await prompt('shared')).reply.turns, 1);
});
