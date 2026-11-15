import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppServer } from '../src/app-server.js';
import { installPlugin } from '../src/plugins.js';
import { PublicError, errorMessage } from '../src/errors.js';
import { hostErrorDetails } from '../src/host-diagnostics.js';

function fixture(install: () => Promise<unknown>) {
  const calls: string[] = [];
  const server = { request: async (method: string) => {
    calls.push(method);
    if (method === 'plugin/read') return { plugin: {
      marketplaceName: 'openai-curated-remote', apps: [], mcpServers: [],
      summary: { name: 'example', installed: false },
    } };
    return install();
  } } as unknown as AppServer;
  return { server, calls };
}

test('uncertain plugin installation retains its cause without retrying or exposing provider text in the public reply', async () => {
  const original = Object.assign(new Error('Private provider response'), { code: 'ETIMEDOUT' });
  const f = fixture(async () => { throw original; });
  await assert.rejects(installPlugin(f.server, 'example', new AbortController().signal,
    async () => ({ install: true })), error => {
    assert.ok(error instanceof PublicError);
    assert.equal(error.cause, original);
    assert.match(errorMessage(error), /may have partially completed/);
    assert.doesNotMatch(errorMessage(error), /Private provider response/);
    const details = hostErrorDetails(error);
    assert.ok(details.nodes.some(node => node.message === original.message && node.stack === original.stack));
    return true;
  });
  assert.deepEqual(f.calls, ['plugin/read', 'plugin/install']);
});

test('declined plugin installation makes no installation request', async () => {
  const f = fixture(async () => assert.fail('Must not install'));
  assert.match(await installPlugin(f.server, 'example', new AbortController().signal,
    async () => ({ install: false })), /declined/);
  assert.deepEqual(f.calls, ['plugin/read']);
});

test('cancellation during plugin installation preserves the abort reason', async () => {
  const controller = new AbortController(), reason = new Error('Cancelled');
  const f = fixture(async () => { controller.abort(reason); throw new Error('Transport closed'); });
  await assert.rejects(installPlugin(f.server, 'example', controller.signal,
    async () => ({ install: true })), error => error === reason);
  assert.deepEqual(f.calls, ['plugin/read', 'plugin/install']);
});
