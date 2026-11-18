import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskTyping, type TypingMeasurement } from '../src/task-typing.js';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureHostDiagnostics, configureOwnerDiagnostics, reportDiagnostic } from '../src/diagnostics.js';
import { installMatrixTransport } from '../src/matrix-transport.js';
import { matrixTyping } from '../src/matrix-typing.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('typing renews with expiry, clears once and stops its timer', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const calls: [boolean, number][] = [];
  const { close } = taskTyping(async (typing, timeout) => { calls.push([typing, timeout]); }, async () => true,
    error => { throw error; }, new AbortController().signal);
  await flush();
  assert.deepEqual(calls, [[true, 30_000]]);
  t.mock.timers.tick(10_000); await flush();
  assert.deepEqual(calls, [[true, 30_000], [true, 30_000]]);
  await close(); await close();
  t.mock.timers.tick(60_000); await flush();
  assert.deepEqual(calls.map(c => c[0]), [true, true, false]);
});

test('abort serializes cleanup after an in-flight send', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const controller = new AbortController(), calls: boolean[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const { close } = taskTyping(async typing => { calls.push(typing); if (typing) await pending; }, async () => true,
    error => { throw error; }, controller.signal);
  await flush();
  t.mock.timers.tick(7_000); await flush();
  assert.deepEqual(calls, [true]);
  controller.abort();
  release(); await close();
  assert.deepEqual(calls, [true, false]);
  t.mock.timers.tick(60_000); await flush();
  assert.deepEqual(calls, [true, false]);
});

test('late authorization cannot renew after cancellation; denied destinations receive no updates', async () => {
  const controller = new AbortController(), calls: boolean[] = [];
  let release!: (allowed: boolean) => void, first = true;
  const { close } = taskTyping(async typing => { calls.push(typing); }, async () => {
    if (!first) return false;
    first = false;
    return new Promise<boolean>(resolve => { release = resolve; });
  }, error => { throw error; }, controller.signal);
  controller.abort(); release(true); await close();
  assert.deepEqual(calls, []);
});

test('typing failures are reported and cleanup still attempts a clear', async () => {
  const errors: unknown[] = [], calls: boolean[] = [];
  const { close } = taskTyping(async typing => { calls.push(typing); throw new Error('offline'); }, async () => true,
    error => errors.push(error), new AbortController().signal);
  await flush(); await close();
  assert.deepEqual(calls, [true, false]);
  assert.equal(errors.length, 2);
});


test('a message waits for an in-flight renewal and restores typing 250 ms after delivery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const events: (boolean | string)[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const typing = taskTyping(async value => { events.push(value); if (events.length === 1) await pending; },
    async () => true, error => { throw error; }, new AbortController().signal);
  await flush();
  const delivery = typing.message(async () => { events.push('message'); });
  await flush(); assert.deepEqual(events, [true]);
  release(); await delivery;
  assert.deepEqual(events, [true, false, 'message']);
  t.mock.timers.tick(249); await flush();
  assert.deepEqual(events, [true, false, 'message']);
  t.mock.timers.tick(1); await flush();
  assert.deepEqual(events, [true, false, 'message', true]);
  await typing.close();
});

test('renewals stay paused until all overlapping deliveries finish, with a fresh delay after the last one', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const calls: boolean[] = [];
  const typing = taskTyping(async value => { calls.push(value); }, async () => true,
    error => { throw error; }, new AbortController().signal);
  await flush();
  let first!: () => void, second!: () => void;
  const a = typing.message(() => new Promise<void>(resolve => { first = resolve; }));
  const b = typing.message(() => new Promise<void>(resolve => { second = resolve; }));
  await flush();
  t.mock.timers.tick(30_000); await flush();
  assert.deepEqual(calls, [true, false, false]);
  first(); await a;
  t.mock.timers.tick(250); await flush();
  assert.deepEqual(calls, [true, false, false]);
  second(); await b;
  t.mock.timers.tick(249); await flush();
  assert.deepEqual(calls, [true, false, false]);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.at(-1), true);
  await typing.close();
});

for (const stop of ['cancel', 'close', 'access revoked'] as const) test(`a delayed restore cannot turn typing on after ${stop}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const calls: boolean[] = [], controller = new AbortController();
  let allowed = true;
  const typing = taskTyping(async value => { calls.push(value); }, async () => allowed,
    error => { throw error; }, controller.signal);
  await flush(); await typing.message(async () => {});
  assert.deepEqual(calls, [true, false]);
  if (stop === 'cancel') controller.abort();
  else if (stop === 'close') await typing.close();
  else allowed = false;
  await flush();
  t.mock.timers.tick(30_000); await flush();
  assert.equal(calls.filter(Boolean).length, 1);
  await typing.close();
});

test('a subsequent message resets the restore delay and delivery errors retain their cause', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const calls: boolean[] = [], failure = new Error('delivery failed');
  const typing = taskTyping(async value => { calls.push(value); }, async () => true,
    error => { throw error; }, new AbortController().signal);
  await flush(); await typing.message(async () => {});
  t.mock.timers.tick(200); await flush();
  await assert.rejects(typing.message(async () => { throw failure; }), error => error === failure);
  t.mock.timers.tick(50); await flush();
  assert.deepEqual(calls, [true, false, false]);
  t.mock.timers.tick(200); await flush();
  assert.equal(calls.at(-1), true);
  await typing.close();
});

test('cancellation during the pre-message clear prevents a stale delivery and any restore', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const calls: boolean[] = [], controller = new AbortController();
  let release!: () => void, delivered = false;
  const clearing = new Promise<void>(resolve => { release = resolve; });
  const typing = taskTyping(async value => { calls.push(value); if (!value) await clearing; },
    async () => true, error => { throw error; }, controller.signal);
  await flush();
  const delivery = typing.message(async () => { delivered = true; });
  await flush(); controller.abort();
  const rejected = assert.rejects(delivery, { name: 'AbortError' });
  release(); await rejected; await typing.close();
  t.mock.timers.tick(30_000); await flush();
  assert.equal(delivered, false);
  assert.equal(calls.filter(Boolean).length, 1);
});

for (const stop of ['retry', 'cancel', 'close'] as const) test(`a stalled send is aborted before expiry: ${stop}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const controller = new AbortController(), calls: boolean[] = [], measurements: TypingMeasurement[] = [];
  const errors: unknown[] = [];
  let sending = false, aborted = false;
  const typing = taskTyping(async (value, _timeout, signal) => {
    assert.equal(sending, false, 'updates must not overlap');
    calls.push(value);
    if (calls.length === 1) {
      sending = true;
      try {
        await new Promise((_, reject) => signal.addEventListener('abort', () => {
          aborted = true; reject(signal.reason);
        }, { once: true }));
      } finally { sending = false; }
    }
  }, async () => true, error => errors.push(error), controller.signal, m => measurements.push(m));
  await flush();
  let closing: Promise<void> | undefined;
  if (stop === 'cancel') controller.abort();
  if (stop === 'close') closing = typing.close();
  t.mock.timers.tick(7_999); await flush();
  assert.equal(aborted, false);
  t.mock.timers.tick(1); await flush();
  assert.equal(aborted, true);
  assert.equal(errors.length, 1);
  assert.equal(measurements[0].status, 'timeout');
  assert.equal(measurements[0].phase, 'send');
  t.mock.timers.tick(2_000); await flush();
  assert.deepEqual(calls, stop === 'retry' ? [true, true] : [true, false]);
  await closing; await typing.close();
  t.mock.timers.tick(60_000); await flush();
  assert.deepEqual(calls, stop === 'retry' ? [true, true, false] : [true, false]);
});

test('a timed-out access check cannot send late and does not block subsequent renewals', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let release!: (allowed: boolean) => void, checks = 0;
  const calls: boolean[] = [], measurements: TypingMeasurement[] = [];
  const typing = taskTyping(async value => { calls.push(value); }, () => ++checks === 1
    ? new Promise(resolve => { release = resolve; }) : Promise.resolve(true), () => {},
  new AbortController().signal, m => measurements.push(m));
  await flush(); t.mock.timers.tick(8_000); await flush();
  assert.equal(measurements[0].status, 'timeout');
  assert.equal(measurements[0].phase, 'authorize');
  release(true); await flush();
  assert.deepEqual(calls, []);
  t.mock.timers.tick(2_000); await flush();
  assert.deepEqual(calls, [true]);
  await typing.close();
});

test('diagnostics omit untrusted error text and broken logging does not prevent cleanup', async () => {
  const measurements: TypingMeasurement[] = [], calls: boolean[] = [];
  const typing = taskTyping(async value => {
    calls.push(value);
    if (value) throw Object.assign(new Error('secret token and server response'), { status: 503 });
  }, async () => true, () => {}, new AbortController().signal, m => {
    measurements.push(m); throw new Error('logger unavailable');
  });
  await flush(); await typing.close();
  assert.deepEqual(calls, [true, false]);
  assert.equal(measurements[0].diagnostic, 'Error, HTTP 503');
  assert.equal(measurements[1].status, 'success');
  assert.equal(JSON.stringify(measurements).includes('secret'), false);
});

test('isolated typing deadlines stay in the journal and consecutive deadlines notify once per update', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.mock.method(console, 'error', () => {});
  const directory = mkdtempSync(join(tmpdir(), 'typing-journal-'));
  const owner: unknown[] = [];
  configureHostDiagnostics(directory);
  configureOwnerDiagnostics(error => owner.push(error));
  t.after(() => {
    configureHostDiagnostics(undefined);
    configureOwnerDiagnostics(undefined);
    rmSync(directory, { recursive: true, force: true });
  });
  let stalled = true;
  const deliveryError = new DOMException('Message timed out', 'TimeoutError');
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.includes('/send/')) throw deliveryError;
    if (stalled) await new Promise<void>((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
    return new Response();
  });
  const homeserver = 'https://matrix.example';
  const transport = installMatrixTransport('auto', [homeserver], undefined, reportDiagnostic);
  t.after(() => transport.destroy());
  const send = matrixTyping({ homeserver, userId: '@bot:example', accessToken: 'test' }, transport.fetch);
  const typing = taskTyping((value, timeout, signal) => send('!room:example', value, timeout, signal),
    async () => true, error => reportDiagnostic(error, { operation: 'bot.operation' }), new AbortController().signal);
  const tick = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
  await flush();
  await tick(8_000);
  assert.equal(owner.length, 0);
  const journal = readFileSync(join(directory, 'errors.jsonl'), 'utf8');
  assert.match(journal, /Typing update timed out/);
  assert.match(journal, /"endpoint":"typing"/);
  await tick(2_000); await tick(8_000);
  assert.equal(owner.length, 1);
  stalled = false;
  await tick(2_000); // successful renewal resets the streak
  stalled = true;
  await tick(10_000); await tick(8_000);
  assert.equal(owner.length, 1);
  stalled = false;
  await assert.rejects(typing.message(() => transport.fetch(homeserver + '/_matrix/client/v3/rooms/r/send/m.room.message/1')),
    error => error === deliveryError);
  assert.equal(owner.length, 2);
  assert.equal(owner[1], deliveryError);
  await typing.close();
});
