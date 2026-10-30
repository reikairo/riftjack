import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:net';
import { startBackendTools } from '../../src/backend-tools.js';
import { loadConfig } from '../../src/config.js';
const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: process.cwd() });
const action = async () => '{}';
for (const kind of ['codex', 'claude', 'pi'] as const) test(`${kind} uses the common tool gates and closes every endpoint`, async () => {
  const tools = await startBackendTools({ kind, config: { ...config, sandbox: 'read-only' }, outbox: process.cwd(),
    signal: new AbortController().signal, allowPublication: true, publish: action,
    hooks: { detached: action, confirmation: action, github: action, background: action } });
  const endpoints = [...tools.connections];
  assert.equal(tools.detached, undefined); assert.equal(tools.publication, undefined);
  assert.ok(tools.github && tools.background);
  assert.equal(!!tools.confirmation, kind !== 'pi');
  assert.equal(/run_detached/.test(tools.instructions), false);
  try {
    for (const endpoint of endpoints) {
      const response = await fetch(endpoint.url, { method: 'POST', headers: { ...endpoint.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      assert.equal(response.status, 200);
    }
  } finally { await tools.close(); }
  for (const endpoint of endpoints) await assert.rejects(fetch(endpoint.url));
});
test('partial setup failure closes already opened endpoints', async t => {
  let closed = 0;
  const original = Server.prototype.close;
  t.mock.method(Server.prototype, 'close', function(this: Server, ...args: Parameters<Server['close']>) { closed++; return original.apply(this, args); });
  await assert.rejects(startBackendTools({ kind: 'codex', config, outbox: process.cwd(), signal: new AbortController().signal,
    allowPublication: false, hooks: { github: action, get background(): typeof action { throw new Error('fixture setup failure'); } } }), /fixture setup failure/);
  assert.equal(closed, 1);
});
