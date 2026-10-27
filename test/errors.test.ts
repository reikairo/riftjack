import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage, safeErrorSummary, PublicError } from '../src/errors.js';

test('safe diagnostics traverse fetch aggregate causes without exposing exception data', () => {
  const nested = Object.assign(new Error('password=secret-password'), { code: 'ECONNREFUSED', headers: { Authorization: 'Bearer secret-token' } });
  const error = new TypeError('fetch failed https://user:secret-password@example/path?token=secret-token', {
    cause: new AggregateError([nested, Object.assign(new Error('secret'), { code: 'ENETUNREACH' })], 'secret'),
  });
  const summary = errorMessage(error);
  assert.match(summary, /TypeError.*AggregateError.*ECONNREFUSED.*ENETUNREACH/);
  assert.doesNotMatch(summary, /secret|password|Bearer|https|headers|fetch failed/);
});

test('unknown diagnostic fields and cyclic causes cannot leak or loop', () => {
  const error = { name: 'PRIVATE_NAME', code: 'PRIVATE_CODE', errcode: 'M_PRIVATE_TOKEN', status: 503, cause: undefined as unknown };
  error.cause = error;
  assert.equal(safeErrorSummary(error), 'HTTP 503');
  assert.equal(safeErrorSummary('secret'), 'Error (no safe diagnostic details available)');
  assert.equal(safeErrorSummary({ status: Infinity, statusCode: 123456 }), 'Error (no safe diagnostic details available)');
});

test('only intentionally public errors are displayed verbatim', () => {
  assert.equal(errorMessage(new PublicError('Check the tunnel.')), 'Check the tunnel.');
  assert.equal(errorMessage(new Error('private data'), 'Bot startup failed'), 'Bot startup failed: Error.');
});

test('process and filesystem causes retain safe details across public wrappers', () => {
  const raw = Object.assign(new Error('token=secret, /private/data'), {
    code: 'ENOSPC', syscall: 'write', stderr: 'Bearer secret', signal: 'SIGKILL', killed: true,
    cause: { code: 7, statusCode: 503 },
  });
  const message = errorMessage(new PublicError('Saving output failed.', { cause: raw }));
  for (const detail of ['ENOSPC', 'write', 'SIGKILL', 'process killed', 'exit 7', 'HTTP 503']) assert.ok(message.includes(detail));
  assert.doesNotMatch(message, /secret|Bearer|private/);
  assert.equal(safeErrorSummary({ code: -32603, signal: 'PRIVATE_SIGNAL', syscall: 'spawn /secret/path' }), 'Error (no safe diagnostic details available)');
});

test('SQLite diagnostics retain the bounded engine code without database contents', () => {
  assert.equal(safeErrorSummary({ code: 'ERR_SQLITE_ERROR', errcode: 13, message: 'secret database path' }), 'ERR_SQLITE_ERROR, SQLite 13');
});
