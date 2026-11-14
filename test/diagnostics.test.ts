import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticContext, diagnosticOperation, diagnosticRecord, matrixEndpoint, transportConfiguration } from '../src/diagnostics.js';
import { PublicError } from '../src/errors.js';

test('nested operations retain their failure context through cause wrappers without private data', async () => {
  const error = Object.assign(new Error('Bearer private-token, private-body'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
  await assert.rejects(diagnosticOperation({ operation: 'worker.claim', bot: 'private-bot', task: 'private-task', taskAttempt: 4 },
    () => diagnosticOperation({ operation: 'worker.authorize' },
      () => diagnosticOperation({ operation: 'matrix.request', method: 'GET', endpoint: 'room-state', attempt: 1 },
        async () => { throw error; }))), e => e === error);
  const record = diagnosticRecord(new Error('private-wrapper', { cause: error }), { operation: 'worker.http', bot: undefined });
  assert.deepEqual(record.operations, ['worker.claim', 'worker.authorize', 'matrix.request']);
  assert.equal(record.failedOperation, 'matrix.request');
  assert.equal(record.operation, 'worker.http');
  assert.equal(record.attempt, 1);
  assert.equal(record.taskAttempt, 4);
  assert.equal(record.endpoint, 'room-state');
  assert.match(record.bot!, /^[a-f0-9]{16}$/);
  assert.match(record.error, /UND_ERR_HEADERS_TIMEOUT/);
  assert.doesNotMatch(JSON.stringify(record), /private|Bearer/);
  assert.equal(diagnosticContext(), undefined);
});

test('concurrent failures keep task contexts isolated and a reused exception records the new attempt', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = new Error('first'), second = new Error('second');
  const one = diagnosticOperation({ operation: 'worker.send', task: 'one' }, async () => { await gate; throw first; });
  await assert.rejects(diagnosticOperation({ operation: 'worker.authorize', task: 'two' }, async () => { throw second; }));
  release(); await assert.rejects(one);
  const a = diagnosticRecord(first, { operation: 'worker.http' });
  const b = diagnosticRecord(second, { operation: 'worker.http' });
  assert.notEqual(a.task, b.task); assert.notEqual(a.trace, b.trace);
  assert.equal(a.failedOperation, 'worker.send'); assert.equal(b.failedOperation, 'worker.authorize');
  await assert.rejects(diagnosticOperation({ operation: 'matrix.request', attempt: 2 }, async () => { throw first; }));
  assert.equal(diagnosticRecord(first, { operation: 'worker.http' }).attempt, 2);
  assert.equal(await diagnosticOperation({ operation: 'worker.send' }, async () => 'recovered'), 'recovered');
  assert.equal(diagnosticContext(), undefined);
});

test('diagnostic accessors cannot obscure the original error and unknown URLs stay categorical', async () => {
  const error = { get code() { throw new Error('private getter'); }, get cause() { throw new Error('private getter'); } };
  await assert.rejects(diagnosticOperation({ operation: 'worker.send' }, async () => { throw error; }), e => e === error);
  assert.doesNotMatch(JSON.stringify(diagnosticRecord(error, { operation: 'worker.http' })), /private getter/);
  const publicError = new PublicError('Authored message');
  Object.defineProperty(publicError, 'cause', { get() { throw new Error('private getter'); } });
  assert.doesNotMatch(JSON.stringify(diagnosticRecord(publicError, { operation: 'worker.http' })), /private getter/);
  for (const [path, category] of [
    ['/_matrix/client/v3/sync?since=private-token', 'sync'],
    ['/_matrix/client/v3/rooms/private-room/send/private-type/private-transaction', 'room-send'],
    ['/_matrix/client/v3/rooms/private-room/state/private-key', 'room-state'],
    ['/_matrix/media/v3/download/private-server/private-file', 'media'],
    ['/_synapse/admin/v1/private', 'admin'], ['/_matrix/private-token', 'other'],
  ]) assert.equal(matrixEndpoint(path), category);
});

test('route configuration exposes policy and separation without proxy credentials or hosts', () => {
  const record = transportConfiguration('auto', 'https://private.example', 'http://127.0.0.1:18008', true,
    { HTTPS_PROXY: 'https://private-user:private-password@private-proxy', NODE_USE_ENV_PROXY: '1' });
  assert.equal(record.homeserverAndAdminSameOrigin, false);
  assert.equal(record.adminLoopback, true);
  assert.equal(record.proxyEnvironmentPresent, true);
  assert.equal(record.nodeEnvProxyEnabled, true);
  assert.equal(record.routeObservation, 'configuration-only');
  assert.doesNotMatch(JSON.stringify(record), /private|18008|https:/);
});

test('unknown errors retain connector source locations without raw stacks or exception messages', () => {
  const error = new Error('private-body');
  error.stack = 'Error: private-body\n    at privateFunction (' + new URL('../src/worker-service.ts', import.meta.url).pathname + ':123:4)\n' +
    '    at secret (/private/secret-path:8:9)\n    at https://private-token@example.com/file:1:2';
  for (const wrapped of [error, new AggregateError([error, error], 'private-wrapper')]) {
    const record = diagnosticRecord(wrapped, { operation: 'worker.send' });
    assert.deepEqual(record.locations, [{ file: 'worker-service.ts', line: 123, column: 4 }]);
    assert.doesNotMatch(JSON.stringify(record), /private|secret|Function|https/);
  }
});
