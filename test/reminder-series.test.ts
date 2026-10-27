import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundTasks, type BackgroundTarget } from '../src/background-tasks.js';
import type { MatrixEvent } from '../src/bridge.js';
const target: BackgroundTarget = { room: '!r:test', sender: '@h:test', key: 'key', session: 'session' };
const signal = new AbortController().signal;
const minute = 60_000;
const input = { action: 'remind', label: 'Series', message: 'Check work', deliver: 'agent', schedule: { frequency: 'interval', interval_minutes: 10, count: 3 } };
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-27T09:00:00Z') });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'riftjack-series-'))), file = join(root, 'state.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let queue = new BackgroundTasks(file, root);
  const action = (args: unknown) => JSON.parse(queue.action(args, target, signal));
  const list = () => action({ action: 'list' });
  const events: string[] = [];
  const options = { valid: () => true, report: (e: unknown) => { throw e; },
    deliver: async (_t: BackgroundTarget, event: MatrixEvent, admit: () => void) => { admit(); events.push(event.event_id!); return true; } };
  return { file, root, action, list, events, options, get queue() { return queue; },
    restart: () => { queue = new BackgroundTasks(file, root); },
    pump: async (now: number) => { t.mock.timers.setTime(now); await queue.pump(options); } };
}

test('finite series persists its anchor and finishes after exactly three slots, without a replacement ID', async t => {
  const f = setup(t), saved = f.action(input), start = Date.parse(saved.due);
  assert.equal(start, Date.now() + 10 * minute); assert.equal(saved.remaining, 3);
  await f.pump(start); assert.equal(f.list()[0].remaining, 2);
  f.restart(); assert.equal(f.list()[0].id, saved.id); assert.equal(f.list()[0].schedule.start_at, saved.due);
  await f.pump(start + 10 * minute); await f.pump(start + 20 * minute); await f.pump(start + 30 * minute);
  assert.equal(f.events.length, 3); assert.equal(new Set(f.events).size, 3); assert.deepEqual(f.list(), []);
  const history = f.action({ action: 'history' }).items[0];
  assert.equal(history.id, saved.id); assert.equal(history.remaining, 0); assert.equal(history.due, null);
});

test('missed slots consume count and cannot produce a catch-up burst or extend the deadline', async t => {
  const f = setup(t), start = Date.parse(f.action(input).due);
  f.restart(); await f.pump(start + 21 * minute);
  assert.equal(f.events.length, 1); assert.deepEqual(f.list(), []);
  await f.pump(start + 22 * minute); assert.equal(f.events.length, 1);
});

test('an entirely expired finite series finishes silently', async t => {
  const f = setup(t), start = Date.parse(f.action(input).due);
  await f.pump(start + 30 * minute);
  assert.equal(f.events.length, 0); assert.deepEqual(f.list(), []);
  assert.equal(f.action({ action: 'history' }).items[0].result, 'series_expired');
});

test('daily series skip expired windows and resume on the next selected day', async t => {
  const f = setup(t), saved = f.action({ ...input, schedule: { frequency: 'daily', time: '10:00', timezone: 'UTC', weekdays: [2,4], interval_minutes: 10, count: 2 } });
  await f.pump(Date.parse('2026-10-27T10:20:00Z'));
  assert.equal(f.events.length, 0); assert.equal(f.list()[0].due, '2026-10-29T10:00:00.000Z');
  f.restart(); await f.pump(Date.parse('2026-10-29T10:00:00Z'));
  assert.equal(f.events.length, 1); assert.equal(f.list()[0].id, saved.id); assert.equal(f.list()[0].remaining, 1);
  f.action({ action: 'cancel', id: saved.id }); await f.pump(Date.parse('2026-10-29T10:10:00Z'));
  assert.equal(f.events.length, 1);
});

test('long-running turns skip slots elapsed during execution, including the final slot', async t => {
  const f = setup(t), start = Date.parse(f.action(input).due);
  t.mock.timers.setTime(start);
  let complete!: () => void;
  await f.queue.pump({ ...f.options, deliver: async (_t, _e, admit, _ready, completed) => { admit(); complete = completed; return false; } });
  t.mock.timers.setTime(start + 15 * minute); complete();
  assert.equal(f.list()[0].due, new Date(start + 20 * minute).toISOString());
  await f.queue.pump(f.options); assert.equal(f.events.length, 0);
  t.mock.timers.setTime(start + 20 * minute);
  await f.queue.pump({ ...f.options, deliver: async (_t, _e, admit, _ready, completed) => { admit(); t.mock.timers.setTime(start + 45 * minute); completed(); return true; } });
  assert.deepEqual(f.list(), []);
});

test('last admitted slot recovers the same event after restart, without restarting the count', async t => {
  const f = setup(t), saved = f.action({ ...input, schedule: { ...input.schedule, count: 1 } });
  t.mock.timers.setTime(Date.parse(saved.due)); let id = '';
  await f.queue.pump({ ...f.options, deliver: async (_t, e, admit) => { admit(); id = e.event_id!; return false; } });
  assert.equal(f.list()[0].state, 'interrupted'); assert.equal(f.list()[0].remaining, 0);
  f.restart(); t.mock.timers.setTime(Date.now() + 60 * minute);
  await f.queue.pump({ ...f.options, deliver: async (_t, e, admit) => {
    assert.equal(e.event_id, id); assert.match(e.content!.body!, /recovery after restart/); admit(); return true;
  } });
  f.restart(); await f.queue.pump(f.options); assert.deepEqual(f.list(), []); assert.equal(f.events.length, 0);
});

test('uncertain final room posts are not replayed after restart', async t => {
  const f = setup(t), saved = f.action({ ...input, deliver: 'room', schedule: { ...input.schedule, count: 1 } });
  t.mock.timers.setTime(Date.parse(saved.due));
  await f.queue.pump({ ...f.options, report: () => {}, post: async (_t, _m, admit) => { admit(); throw new Error('connection lost'); } });
  f.restart(); await f.queue.pump({ ...f.options, post: async () => assert.fail('must not replay') });
  assert.equal(f.list()[0].state, 'interrupted'); assert.equal(f.list()[0].remaining, 0);
});

test('update keeps one ID, resets schedule, rejects other sessions and unfinished deliveries', async t => {
  const f = setup(t), saved = f.action(input);
  const replacement = { ...input, action: 'update', id: saved.id, schedule: { ...input.schedule, interval_minutes: 5, count: 2 } };
  assert.throws(() => f.queue.action(replacement, { ...target, session: 'other' }, signal));
  const changed = f.action(replacement); assert.equal(changed.id, saved.id); assert.equal(f.list().length, 1);
  assert.equal(changed.remaining, 2); assert.equal(Date.parse(changed.due), Date.now() + 5 * minute);
  t.mock.timers.setTime(Date.parse(changed.due));
  await f.queue.pump({ ...f.options, deliver: async (_t, _e, admit) => { admit(); assert.throws(() => f.action(replacement)); return false; } });
  assert.throws(() => f.action(replacement));
  f.action({ action: 'cancel', id: saved.id }); assert.throws(() => f.action(replacement));
});

test('invalid interval registrations and corrupted persistence are rejected before delivery', t => {
  const f = setup(t);
  for (const schedule of [{ ...input.schedule, start_at: '2026-10-27T08:00:00Z' },
    { ...input.schedule, start_at: '2028-01-01T00:00:00Z' }, { ...input.schedule, count: -1 }]) {
    assert.throws(() => f.action({ ...input, schedule }));
  }
  f.action(input); const original = JSON.parse(readFileSync(f.file, 'utf8'));
  const corrupt = structuredClone(original); delete corrupt.watches[0].timer.schedule.start_at;
  writeFileSync(f.file, JSON.stringify(corrupt)); assert.throws(() => new BackgroundTasks(f.file, f.root), /Invalid background/);
  original.watches[0].timer.exhausted = 'yes'; writeFileSync(f.file, JSON.stringify(original));
  assert.throws(() => new BackgroundTasks(f.file, f.root), /Invalid background/);
});

test('a crash during the last room send retains uncertainty but never schedules it again', async t => {
  const f = setup(t), saved = f.action({ ...input, deliver: 'room', schedule: { ...input.schedule, count: 1 } });
  t.mock.timers.setTime(Date.parse(saved.due)); let persisted = '';
  await f.queue.pump({ ...f.options, post: async (_t, _m, admit) => { admit(); persisted = readFileSync(f.file, 'utf8'); return true; } });
  writeFileSync(f.file, persisted); f.restart();
  assert.equal(f.list()[0].state, 'interrupted'); assert.equal(f.list()[0].lastRun.state, 'interrupted');
  await f.queue.pump({ ...f.options, post: async () => assert.fail('uncertain send must not replay') });
});

test('an old completion callback cannot finish a later occurrence', async t => {
  const f = setup(t), start = Date.parse(f.action(input).due); let oldComplete!: () => void;
  t.mock.timers.setTime(start);
  await f.queue.pump({ ...f.options, deliver: async (_t, _e, admit, _r, complete) => { admit(); oldComplete = complete; return true; } });
  t.mock.timers.setTime(start + 10 * minute);
  await f.queue.pump({ ...f.options, deliver: async (_t, _e, admit) => { admit(); oldComplete(); return false; } });
  assert.equal(f.list()[0].state, 'interrupted'); assert.equal(f.list()[0].lastRun.state, 'interrupted');
});

test('unlimited intervals keep the anchor across downtime; explicit starts and overview are preserved', async t => {
  const f = setup(t);
  const saved = f.action({ ...input, schedule: { frequency: 'interval', interval_minutes: 7, start_at: '2026-10-27T10:03:00Z' } });
  f.restart(); await f.pump(Date.parse('2026-10-27T11:00:00Z'));
  assert.equal(f.events.length, 1); assert.equal(f.list()[0].due, '2026-10-27T11:06:00.000Z');
  assert.equal(f.list()[0].schedule.start_at, '2026-10-27T10:03:00Z');
  assert.match(f.queue.overview(target), /every 7 minutes/);
  assert.doesNotMatch(f.queue.overview(target), /Remaining|Check work/);
  f.action({ action: 'cancel', id: saved.id }); f.restart(); await f.pump(Date.parse('2026-10-27T12:00:00Z'));
  assert.equal(f.events.length, 1);
});

test('updating during the access check invalidates the old pending delivery', async t => {
  const f = setup(t), saved = f.action(input);
  t.mock.timers.setTime(Date.parse(saved.due));
  await f.queue.pump({ ...f.options, deliver: async (_t, _e, _admit, ready) => {
    f.action({ ...input, action: 'update', id: saved.id, message: 'New instruction' });
    assert.equal(ready(), false); return false;
  } });
  assert.equal(f.list()[0].message, 'New instruction'); assert.equal(f.list()[0].remaining, 3);
});

test('an occurrence that expires during the access check is not admitted', async t => {
  const f = setup(t), saved = f.action({ ...input, schedule: { ...input.schedule, count: 1 } });
  const start = Date.parse(saved.due); t.mock.timers.setTime(start);
  await f.queue.pump({ ...f.options, deliver: async (_t, _e, _admit, ready) => {
    t.mock.timers.setTime(start + 10 * minute); assert.equal(ready(), false); return false;
  } });
  await f.queue.pump(f.options); assert.deepEqual(f.list(), []); assert.equal(f.events.length, 0);
});
