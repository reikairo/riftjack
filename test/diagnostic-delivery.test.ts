import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticDelivery } from '../src/diagnostic-delivery.js';
import { loadConfig } from '../src/config.js';
import { configureOwnerDiagnostics, diagnosticOperation, reportDiagnostic } from '../src/diagnostics.js';
import { OwnerDiagnosticDelivery, type OwnerReport } from '../src/owner-diagnostics.js';

test('owner diagnostic notices are enabled by default and support an explicit opt-out', () => {
  const env = { MATRIX_HOMESERVER: 'https://matrix.example', MATRIX_OWNER_ID: '@owner:example',
    RIFTJACK_WORKSPACE: process.cwd() };
  assert.equal(loadConfig(env).ownerDiagnosticNotices, true);
  assert.equal(loadConfig({ ...env, OWNER_DIAGNOSTIC_NOTICES: 'false' }).ownerDiagnosticNotices, false);
  assert.throws(() => loadConfig({ ...env, OWNER_DIAGNOSTIC_NOTICES: 'off' }), /OWNER_DIAGNOSTIC_NOTICES/);
});

test('background reports retain original details, group repeats and send the latest event after cooldown', async () => {
  let now = 0;
  const queue = new DiagnosticDelivery(() => now, 100);
  const sent: string[] = [];
  const send = async (report: OwnerReport) => { sent.push(report.details); return true; };
  const error = { message: 'first timeout', code: 'ETIMEDOUT', stack: 'dependency stack' };
  queue.record(error, { operation: 'matrix.request', bot: '@bot:example.com' });
  await queue.flush(send);
  assert.match(sent[0], /first timeout/); assert.match(sent[0], /dependency stack/);
  assert.match(sent[0], /@bot:example.com/);
  queue.record({ ...error, message: 'second timeout' }, { operation: 'matrix.request', bot: '@bot:example.com' });
  queue.record({ ...error, message: 'third timeout' }, { operation: 'matrix.request', bot: '@bot:example.com' });
  await queue.flush(send); assert.equal(sent.length, 1);
  now = 100;
  await queue.flush(send);
  assert.equal(sent.length, 2); assert.match(sent[1], /Occurrences: 2/); assert.match(sent[1], /third timeout/);
  await queue.flush(send); assert.equal(sent.length, 2);
});

test('delivery serializes flushes, retains unavailable targets and reports queue overflow', async () => {
  let now = 0;
  const queue = new DiagnosticDelivery(() => now, 100, 1);
  queue.record(new Error('first'), { operation: 'sync' });
  queue.record(new Error('overflow'), { operation: 'other' });
  let release!: (value: boolean) => void, calls = 0;
  const flush = queue.flush(async () => { calls++; return new Promise(resolve => { release = resolve; }); });
  await queue.flush(async () => { calls++; return true; });
  assert.equal(calls, 1);
  now = 100;
  queue.record(new Error('still overflow'), { operation: 'other' });
  release(false); await flush;
  await queue.flush(async ({ details: body }) => {
    assert.match(body, /Occurrences: 1/); assert.match(body, /omitted from the delivery queue: 2/);
    assert.match(body, /first/); return true;
  });
});

test('failed diagnostic delivery is logged but never recursively queued or retried', async t => {
  t.mock.method(console, 'error', () => {});
  const queue = new DiagnosticDelivery(() => 0, 100);
  let recorded = 0, sends = 0;
  configureOwnerDiagnostics((error, context) => { recorded++; queue.record(error, context); });
  t.after(() => configureOwnerDiagnostics(undefined));
  reportDiagnostic(new Error('original'), { operation: 'sync' });
  await queue.flush(async () => {
    sends++;
    reportDiagnostic(new Error('nested HTTP delivery failure'), { operation: 'matrix.request' });
    throw new Error('uncertain send');
  });
  await queue.flush(async () => { sends++; return true; });
  assert.equal(recorded, 1); assert.equal(sends, 1);
});

test('direct task delivery suppresses recursive reports while preserving observed operation context', async t => {
  t.mock.method(console, 'error', () => {});
  const events: any[] = [];
  configureOwnerDiagnostics((error, context) => events.push({ error, context }));
  t.after(() => configureOwnerDiagnostics(undefined));
  let failure: unknown;
  try {
    await diagnosticOperation({ operation: 'worker.claim', bot: '@bot:example.com', task: 'task-42' }, async () => {
      throw new Error('claim failed');
    });
  } catch (error) { failure = error; }
  reportDiagnostic(failure, { operation: 'worker.http' });
  assert.equal(events[0].context.bot, '@bot:example.com');
  assert.equal(events[0].context.task, 'task-42');
  await assert.rejects(new OwnerDiagnosticDelivery({
    allowed: async () => true, stopping: () => false,
    prepare: async () => ({}), react: async () => '', remove: async () => {},
    send: async () => { reportDiagnostic(new Error('HTTP failure'), { operation: 'matrix.request' }); throw new Error('failed'); },
  }).text('diagnostic', 'home'));
  assert.equal(events.length, 1);
});

test('background batches update the existing report counter without more attachments', async () => {
  let now = 0;
  const queue = new DiagnosticDelivery(() => now, 100);
  const events: any[] = [], reactions: string[] = [];
  const delivery = new OwnerDiagnosticDelivery({
    allowed: async () => true, stopping: () => false, prepare: async () => ({ msgtype: 'm.file' }),
    send: async (_room, content) => { events.push(content); return '$report'; },
    react: async (_room, event, key) => { assert.equal(event, '$report'); reactions.push(key); return '$reaction'; },
    remove: async () => {},
  }, () => now);
  const send = async (report: OwnerReport) => { await delivery.send(report, 'home'); return true; };
  queue.record({ code: 'ETIMEDOUT' }, { operation: 'sync' });
  await queue.flush(send);
  for (let i = 0; i < 10; i++) queue.record({ code: 'ETIMEDOUT' }, { operation: 'sync' });
  await queue.flush(send); assert.equal(events.length, 1); assert.equal(reactions.length, 0);
  now = 100; await queue.flush(send);
  assert.equal(events.length, 1); assert.deepEqual(reactions, ['+10']);
});
