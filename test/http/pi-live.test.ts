import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPiBackend } from '../../src/pi-backend.js';
import { loadConfig } from '../../src/config.js';
import { State } from '../../src/state.js';

// Optional installed-Pi contract test. All model responses come from localhost;
// credentials and configuration live in a fresh temporary directory.
const cli = process.env.RIFTJACK_TEST_PI;
test('installed Pi: readiness, tools, denial, final text, resume and cancellation', {
  skip: !cli || process.platform === 'win32', timeout: 30000,
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'riftjack-pi-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let command = 'printf approved > approved';
  let calls = 0;
  let final = 'NO_REPLY';
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const tool = calls % 2 === 1;
    const delta = tool ? { role: 'assistant', content: 'I will use a tool.', tool_calls: [{ index: 0,
      id: `call-${calls}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } }] }
      : { role: 'assistant', content: final };
    res.write(`data: ${JSON.stringify({ id: `completion-${calls}`, object: 'chat.completion.chunk', created: 1,
      model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: `completion-${calls}`, object: 'chat.completion.chunk', created: 1,
      model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const configDir = join(dir, 'config'); mkdirSync(configDir);
  writeFileSync(join(configDir, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'local-test',
    models: [{ id: 'fixture', contextWindow: 32000, maxTokens: 1000 }],
  } } }));
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const wrapper = join(dir, 'pi');
  writeFileSync(wrapper, `#!/bin/sh\nexport PI_CODING_AGENT_DIR=${quote(configDir)}\nexport PI_OFFLINE=1\nexport PI_TELEMETRY=0\nexec ${quote(resolve(cli!))} "$@"\n`);
  chmodSync(wrapper, 0o700);
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://example.com', MATRIX_OWNER_ID: '@owner:example.com',
    RIFTJACK_WORKSPACE: dir, DATA_DIR: join(dir, 'data'), PI_PATH: wrapper, PI_MODEL: 'fixture/fixture' });
  const state = new State(join(dir, 'state.json'));
  const run = createPiBackend(config, state);
  let approvals = 0;
  const approved = await run('pi', 'Run the fixture.', 'conversation', AbortSignal.timeout(10000), '@owner:example.com', [],
    async request => { approvals++; assert.match(request.text, /Allow bash/); return request.approve!; });
  assert.equal(approved, 'NO_REPLY'); assert.equal(approvals, 1); assert.ok(existsSync(join(dir, 'approved')));
  const session = state.session('conversation').pi;
  assert.ok(session);
  command = 'printf denied > denied'; final = 'Denied.';
  const denied = await run('pi', 'Decline the fixture.', 'conversation', AbortSignal.timeout(10000), '@owner:example.com', [],
    async request => request.deny);
  assert.equal(denied, 'Denied.'); assert.equal(existsSync(join(dir, 'denied')), false);
  assert.equal(state.session('conversation').pi, session);
  assert.ok(JSON.stringify(requests[2].messages).includes('NO_REPLY'), 'resumed model request contains previous reply');

  command = 'printf ready > ready; sleep 2; printf survived > survived';
  const controller = new AbortController();
  t.after(() => controller.abort());
  const task = run('pi', 'Cancel the fixture.', 'conversation', controller.signal, '@owner:example.com', [], async request => request.approve!);
  const rejected = assert.rejects(task, /cancel live fixture/);
  for (let n = 0; n < 500 && !existsSync(join(dir, 'ready')); n++) await delay(10);
  assert.ok(existsSync(join(dir, 'ready')), 'the real Pi bash tool started');
  controller.abort(new Error('cancel live fixture'));
  await rejected;
  await delay(2300);
  assert.equal(existsSync(join(dir, 'survived')), false);
});
