import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRequestFn, setRequestFn } from '@vector-im/matrix-bot-sdk';
import { getGlobalDispatcher } from 'undici';
import { installMatrixTransport } from '../src/matrix-transport.js';
import { loadConfig } from '../src/config.js';

test('Matrix protocol configuration defaults to auto and rejects unsupported values', () => {
  const env = { MATRIX_HOMESERVER: 'https://matrix.example', MATRIX_OWNER_ID: '@owner:example', RIFTJACK_WORKSPACE: process.cwd() };
  assert.equal(loadConfig(env).matrixHttpVersion, 'auto');
  assert.equal(loadConfig({ ...env, MATRIX_HTTP_VERSION: ' 1.1 ' }).matrixHttpVersion, '1.1');
  for (const value of ['2', 'http1', 'false']) {
    assert.throws(() => loadConfig({ ...env, MATRIX_HTTP_VERSION: value }), /MATRIX_HTTP_VERSION/);
  }
});

test('auto leaves SDK, fetch and the global dispatcher unchanged', async () => {
  const request = getRequestFn(), fetcher = globalThis.fetch, global = getGlobalDispatcher();
  const transport = installMatrixTransport('auto', ['https://matrix.example'], () => { throw new Error('Unexpected agent'); });
  assert.equal(getRequestFn(), request);
  assert.equal(transport.fetch, fetcher);
  assert.equal(getGlobalDispatcher(), global);
  await transport.destroy();
  assert.equal(getRequestFn(), request);
});

test('HTTP/1.1 preserves SDK options and only overrides configured origins', async t => {
  const original = getRequestFn(), global = getGlobalDispatcher();
  const calls: any[] = [];
  setRequestFn(async (...args: any[]) => { calls.push(args); return {}; });
  t.after(() => setRequestFn(original));
  const transport = installMatrixTransport('1.1', ['https://matrix.example/base', 'http://127.0.0.1:18008']);
  t.after(() => transport.destroy());
  const init = { method: 'PUT' as const, body: 'payload', headers: { Authorization: 'Bearer test' }, headersTimeout: 321, bodyTimeout: 654, signal: new AbortController().signal };
  await getRequestFn()('https://matrix.example/_matrix/client/v3/rooms/a/send/b/c', init);
  const { dispatcher, ...forwarded } = calls[0][1];
  assert.ok(dispatcher);
  assert.deepEqual(forwarded, init);
  await getRequestFn()('https://matrix.example/_matrix/client/v3/sync?timeout=30000', { method: 'GET' });
  assert.notEqual(calls[1][1].dispatcher, dispatcher);
  await getRequestFn()('http://127.0.0.1:18008/_synapse/admin/v1/register', init);
  assert.equal(calls[2][1].dispatcher, dispatcher);
  await getRequestFn()('https://other.example/path', init);
  assert.equal(calls[3][1], init);
  assert.equal(getGlobalDispatcher(), global);
});
