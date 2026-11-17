import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleLogger, LogService, MatrixError, getRequestFn, setRequestFn } from '@vector-im/matrix-bot-sdk';
import { diagnosticOperation, diagnosticRecord } from '../src/diagnostics.js';
import { matrixSdkLogger } from '../src/matrix-sdk-logger.js';
import { installMatrixTransport } from '../src/matrix-transport.js';
import { RateLimitedMatrixClient } from '../src/rate-limited-matrix-client.js';

test('missing optional m.direct remains a rejection but SDK DM loading completes without diagnostics', async t => {
  const original = getRequestFn();
  const records: ReturnType<typeof diagnosticRecord>[] = [];
  const report = (error: unknown, details: Parameters<typeof diagnosticRecord>[1]) => { records.push(diagnosticRecord(error, details)); };
  let calls = 0;
  setRequestFn(async () => {
    calls++;
    return { statusCode: 404, headers: {}, body: {
      bytes: async () => Buffer.from(JSON.stringify({ errcode: 'M_NOT_FOUND', error: 'Account data not found' })),
    } } as any;
  });
  LogService.setLogger(matrixSdkLogger(report));
  const transport = installMatrixTransport('auto', ['https://matrix.example'], undefined, report);
  t.after(async () => { await transport.destroy(); setRequestFn(original); LogService.setLogger(new ConsoleLogger()); });
  const client = new RateLimitedMatrixClient('https://matrix.example', 'private-token');
  client.getUserId = async () => '@bot:example.com';
  client.diagnosticReport = report;
  await assert.rejects(client.getAccountData('m.direct'), error =>
    error instanceof MatrixError && error.statusCode === 404 && error.errcode === 'M_NOT_FOUND');
  assert.equal(calls, 1, 'absence does not trigger retries');
  await client.dms.update();
  assert.equal(calls, 2);
  assert.equal(client.dms.isDm('!room:example.com'), false);
  assert.deepEqual(records, [], 'transport, SDK logger and request reporter all stay quiet');
});

test('other Matrix failures still produce one diagnostic and reject the request', async t => {
  const original = getRequestFn();
  const records: ReturnType<typeof diagnosticRecord>[] = [];
  const report = (error: unknown, details: Parameters<typeof diagnosticRecord>[1]) => { records.push(diagnosticRecord(error, details)); };
  let status = 404, errcode = 'M_NOT_FOUND';
  setRequestFn(async () => ({ statusCode: status, headers: {}, body: {
    bytes: async () => Buffer.from(JSON.stringify({ errcode, error: 'fixture' })),
  } }) as any);
  LogService.setLogger(matrixSdkLogger(report));
  const transport = installMatrixTransport('auto', ['https://matrix.example'], undefined, report);
  t.after(async () => { await transport.destroy(); setRequestFn(original); LogService.setLogger(new ConsoleLogger()); });
  const client = new RateLimitedMatrixClient('https://matrix.example', 'private-token');
  client.diagnosticReport = report;
  const direct = '/_matrix/client/v3/user/%40bot%3Aexample.com/account_data/m.direct';
  for (const [method, endpoint, code, http] of [
    ['PUT', direct, 'M_NOT_FOUND', 404],
    ['GET', direct + '.other', 'M_NOT_FOUND', 404],
    ['GET', '/_matrix/client/v3/user/bot/rooms/room/account_data/m.direct', 'M_NOT_FOUND', 404],
    ['GET', '/_matrix/client/v3/rooms/room/state', 'M_NOT_FOUND', 404],
    ['GET', direct, 'M_UNRECOGNIZED', 404],
    ['GET', direct, 'M_FORBIDDEN', 403],
    ['GET', direct, 'M_NOT_FOUND', 500],
  ] as const) {
    status = http; errcode = code; records.length = 0;
    await assert.rejects(client.doRequest(method, endpoint), error =>
      error instanceof MatrixError && error.statusCode === http && error.errcode === code);
    assert.equal(records.length, 1, `${method} ${endpoint}: ${code}/${http}`);
    assert.equal(records[0].operation, 'matrix.request');
  }
});

for (const stage of ['headers', 'body', 'status'] as const) {
  test(`SDK ${stage} failure has one request diagnostic and later attempts remain visible`, async t => {
    const original = getRequestFn();
    const records: ReturnType<typeof diagnosticRecord>[] = [];
    const report = (error: unknown, details: Parameters<typeof diagnosticRecord>[1]) => { records.push(diagnosticRecord(error, details)); };
    const error = Object.assign(new Error('private-response'), { code: stage === 'body' ? 'UND_ERR_BODY_TIMEOUT' : 'UND_ERR_HEADERS_TIMEOUT' });
    let failing = true;
    setRequestFn(async () => {
      if (failing && stage === 'headers') throw error;
      return { statusCode: failing && stage === 'status' ? 503 : 200, headers: {}, body: {
        bytes: async () => {
          if (failing && stage === 'body') throw error;
          return Buffer.from(failing && stage === 'status' ? JSON.stringify({ errcode: 'M_UNKNOWN', error: 'private-response' }) : '{}');
        },
      } } as any;
    });
    LogService.setLogger(matrixSdkLogger(report));
    const transport = installMatrixTransport('auto', ['https://matrix.example'], undefined, report);
    t.after(async () => { await transport.destroy(); setRequestFn(original); LogService.setLogger(new ConsoleLogger()); });
    const client = new RateLimitedMatrixClient('https://matrix.example', 'private-token');
    client.diagnosticBot = '@bot:example.com'; client.diagnosticReport = report;
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(client.doRequest('GET', '/_matrix/client/v3/sync'));
      assert.equal(records.length, attempt + 1);
      const record = records[attempt];
      assert.equal(record.operation, 'matrix.request');
      assert.equal(record.endpoint, 'sync'); assert.equal(record.attempt, 1);
      assert.ok(record.bot); assert.equal(typeof record.elapsedMs, 'number');
      assert.match(record.error, stage === 'status' ? /M_UNKNOWN/ : new RegExp(error.code));
      assert.doesNotMatch(JSON.stringify(record), /private/);
    }
    assert.notEqual(records[0].trace, records[1].trace);
    failing = false;
    assert.deepEqual(await client.doRequest('GET', '/_matrix/client/v3/sync'), {});
    assert.equal(records.length, 2);
  });
}

test('unowned requests and unrelated SDK errors keep their diagnostics', async t => {
  const original = getRequestFn();
  const records: ReturnType<typeof diagnosticRecord>[] = [];
  const report = (error: unknown, details: Parameters<typeof diagnosticRecord>[1]) => { records.push(diagnosticRecord(error, details)); };
  const failure = Object.assign(new Error('private'), { code: 'ECONNRESET' });
  setRequestFn(async () => { throw failure; });
  const logger = matrixSdkLogger(report);
  LogService.setLogger(logger);
  const transport = installMatrixTransport('auto', ['https://matrix.example'], undefined, report);
  t.after(async () => { await transport.destroy(); setRequestFn(original); LogService.setLogger(new ConsoleLogger()); });
  const client = new RateLimitedMatrixClient('https://matrix.example', 'private-token');
  await assert.rejects(client.doRequest('GET', '/_matrix/client/v3/sync'), e => e === failure);
  assert.deepEqual(records.map(r => r.operation), ['matrix.http', 'matrix.sdk.http']);
  records.length = 0;
  let ready!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const waiting = new Promise<void>(resolve => { resume = resolve; });
  const owned = diagnosticOperation({ operation: 'matrix.request', reportsMatrixErrors: true }, async () => {
    ready(); await waiting;
    logger.error('MatrixClientLite', failure);
    logger.warn('MatrixHttpClient', failure);
  });
  await started;
  try {
    await assert.rejects(getRequestFn()('https://matrix.example/_matrix/client/v3/sync', { method: 'GET' }), e => e === failure);
    assert.deepEqual(records.map(r => r.operation), ['matrix.http']);
  } finally { resume(); await owned; }
  assert.deepEqual(records.map(r => r.operation), ['matrix.http', 'matrix.sdk.client', 'matrix.sdk.http-warning']);
});
