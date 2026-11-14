import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRequestFn, setRequestFn } from '@vector-im/matrix-bot-sdk';
import { getGlobalDispatcher } from 'undici';
import { installMatrixTransport } from '../src/matrix-transport.js';
import { loadConfig } from '../src/config.js';
import { diagnosticRecord, diagnosticOperation } from '../src/diagnostics.js';

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

test('auto diagnostics preserve dispatcher policy, exceptions and request options without logging URLs', async t => {
  const original = getRequestFn(), global = getGlobalDispatcher();
  const error = Object.assign(new Error('secret token in response'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
  const init = { method: 'GET' as const, headers: { Authorization: 'Bearer secret' }, headersTimeout: 123 };
  const calls: any[] = [], records: ReturnType<typeof diagnosticRecord>[] = [];
  setRequestFn(async (...args: any[]) => { calls.push(args); throw error; });
  t.after(() => setRequestFn(original));
  const transport = installMatrixTransport('auto', ['https://matrix.example', 'http://127.0.0.1:18008'],
    () => { throw new Error('Must retain default dispatcher'); },
    (error, details) => records.push(diagnosticRecord(error, details)));
  t.after(() => transport.destroy());
  await assert.rejects(diagnosticOperation({ operation: 'worker.authorize' },
    () => getRequestFn()('https://matrix.example/_matrix/client/v3/rooms/private-room/state?secret=token', init)), e => e === error);
  assert.equal(calls[0][1], init);
  assert.equal(getGlobalDispatcher(), global);
  assert.equal(records[0].destination, 'homeserver');
  assert.equal(records[0].endpoint, 'room-state');
  assert.equal(records[0].transport, 'auto');
  assert.deepEqual(records[0].operations, ['worker.authorize', 'matrix.http']);
  assert.doesNotMatch(JSON.stringify(records), /private-room|secret|token|Bearer|matrix.example/);
  await assert.rejects(getRequestFn()('http://127.0.0.1:18008/_synapse/admin/v1/register', init));
  assert.equal(records[1].destination, 'admin');
  await assert.rejects(getRequestFn()('https://unrelated.example/path', init));
  assert.equal(records.length, 2, 'unrelated traffic is not instrumented');
});

test('fetch diagnostics preserve cancellation and responses for admin requests', async t => {
  const original = globalThis.fetch;
  const calls: unknown[][] = [], records: ReturnType<typeof diagnosticRecord>[] = [];
  const controller = new AbortController();
  const error = Object.assign(new Error('private network details'), { code: 'ECONNRESET' });
  let failure = true;
  const response = new Response('private response', { status: 503 });
  globalThis.fetch = async (...args) => { calls.push(args); if (failure) throw error; return response; };
  t.after(() => { globalThis.fetch = original; });
  const transport = installMatrixTransport('auto', ['https://matrix.example', 'http://127.0.0.1:18008'], undefined,
    (error, details) => records.push(diagnosticRecord(error, details)));
  t.after(() => transport.destroy());
  const init = { method: 'POST', signal: controller.signal, body: 'private request' };
  const url = 'http://127.0.0.1:18008/_synapse/admin/v1/register?token=private-token';
  await assert.rejects(transport.fetch(url, init), e => e === error);
  assert.equal(calls[0][1], init);
  assert.equal(records[0].destination, 'admin');
  assert.match(records[0].error, /ECONNRESET/);
  failure = false;
  assert.equal(await transport.fetch(url, init), response);
  assert.match(records[1].error, /HTTP 503/);
  assert.equal(await response.text(), 'private response');
  assert.doesNotMatch(JSON.stringify(records), /private|127\.0\.0\.1|18008/);
});
