import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const dialect = process.argv[2];
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
let sessionId, turns = 0, model = 'default', pending;
const options = () => [{ id: 'model', name: 'Model', type: 'select', currentValue: model,
  options: [{ value: 'default', name: 'Default' }, { value: 'other', name: 'Other' }] }];
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  appendFileSync('idle-transcript.jsonl', JSON.stringify({ pid: process.pid, ...message }) + '\n');
  const { id, method, params } = message;
  if (method === 'initialize') {
    // Make overlapping cold starts deterministic.
    await new Promise((resolve) => setTimeout(resolve, 60));
    send({ id, result: { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: dialect !== 'no-load' }, authMethods: [] } });
  } else if (method === 'session/new') {
    sessionId = `idle-${process.pid}`;
    send({ id, result: { sessionId, configOptions: options() } });
  } else if (method === 'session/load') {
    if (dialect === 'fail-load') { send({ id, error: { code: -32603, message: 'Cannot load saved session' } }); continue; }
    sessionId = params.sessionId;
    ({ turns, model } = JSON.parse(readFileSync(`${sessionId}.json`, 'utf8')));
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD REPLAY' } } } });
    send({ id, result: { configOptions: options() } });
  } else if (method === 'session/set_config_option') {
    model = params.value;
    send({ id, result: { configOptions: options() } });
  } else if (method === 'session/prompt') {
    turns++;
    pending = id;
    send({ id: 'permission', method: 'session/request_permission', params: { sessionId,
      toolCall: { toolCallId: 'test', title: 'Continue?', status: 'pending' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } });
  } else if (id === 'permission' && message.result) {
    writeFileSync(`${sessionId}.json`, JSON.stringify({ turns, model }));
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: JSON.stringify({ turns, model, pid: process.pid }) } } } });
    send({ id: pending, result: { stopReason: 'end_turn' } });
  }
}
