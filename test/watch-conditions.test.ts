import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, utimesSync, renameSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundTasks, type BackgroundTarget } from '../src/background-tasks.js';
import { prepareConditions, observeConditions, watchInterval, type ProcessProbe } from '../src/watch-conditions.js';

const target: BackgroundTarget = { room: '!room:test', sender: '@alice:test', key: 'key', session: 'session' };
const input = { action: 'watch', label: 'Build', mode: 'text', status_file: 'result', text_condition: { operator: 'starts_with', value: 'exit ' } };
function setup(t: test.TestContext, probe: ProcessProbe = () => undefined) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'riftjack-watch-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'result'), 'running\n'); writeFileSync(join(root, 'log'), 'building\n');
  const file = join(root, 'watches.json');
  const queue = new BackgroundTasks(file, root, probe);
  const register = (data: object) => JSON.parse(queue.action(data, target, new AbortController().signal));
  const received: any[] = [];
  const options = { valid: () => true, report: (error: unknown) => { throw error; },
    deliver: async (_target: BackgroundTarget, event: any, admit: () => void) => {
      admit(); received.push(JSON.parse(event.content.body.split('\n').at(-1))); return true;
    } };
  return { root, file, queue, register, received, options };
}

test('text result selects only the first nonempty line and survives restart', async t => {
  const f = setup(t); f.register(input);
  writeFileSync(join(f.root, 'result'), '\n running\r\nexit 0\nprivate detail');
  await f.queue.pump(f.options); assert.equal(f.received.length, 0);
  writeFileSync(join(f.root, 'result'), '\nexit 7\nprivate detail');
  const resumed = new BackgroundTasks(f.file, f.root);
  await resumed.pump(f.options);
  assert.equal(f.received[0].status, 'watch_text_matched'); assert.equal(f.received[0].line, 'exit 7');
  assert.ok(!JSON.stringify(f.received).includes('private detail'));
  await resumed.pump(f.options); assert.equal(f.received.length, 1);
});

test('not_equals never treats an empty file as completion', async t => {
  const f = setup(t); f.register({ ...input, text_condition: { operator: 'not_equals', value: 'running' } });
  const now = Date.now(); writeFileSync(join(f.root, 'result'), '\n\n');
  await f.queue.pump(f.options, now); assert.equal(f.received.length, 0);
  writeFileSync(join(f.root, 'result'), 'failed'); await f.queue.pump(f.options, now + 2000);
  assert.equal(f.received[0].line, 'failed');
});

test('text completion wins when the associated log is also idle', async t => {
  const f = setup(t); const now = Date.now();
  utimesSync(join(f.root, 'log'), new Date(now - 10000), new Date(now - 10000));
  f.register({ ...input, idle_file: 'log', idle_seconds: 5 });
  writeFileSync(join(f.root, 'result'), 'exit 0');
  await f.queue.pump(f.options, now);
  assert.equal(f.received[0].status, 'watch_text_matched');
});

test('idle checks scale with period and stat large logs without parsing them', async t => {
  const f = setup(t); const now = Date.now();
  truncateSync(join(f.root, 'log'), 1000000);
  utimesSync(join(f.root, 'log'), new Date(now), new Date(now));
  const registered = f.register({ action: 'watch', label: 'Log', mode: 'idle', idle_file: 'log', idle_seconds: 60 });
  assert.equal(registered.poll_interval_seconds, 12);
  await f.queue.pump(f.options, now + 59000); assert.equal(f.received.length, 0);
  await f.queue.pump(f.options, now + 60000); assert.equal(f.received.length, 0); // Not due for another stat.
  await f.queue.pump(f.options, now + 71000);
  assert.equal(f.received[0].status, 'watch_file_idle'); assert.equal(f.received[0].idle_seconds, 71);
  const spec = prepareConditions({ action: 'watch', mode: 'idle', idle_file: 'log', idle_seconds: 5 }, f.root, now, () => undefined);
  assert.equal(watchInterval(spec), 1000);
});

test('atomic replacement and truncation reset inactivity and persist across restart', async t => {
  const f = setup(t); const now = Date.now();
  utimesSync(join(f.root, 'log'), new Date(now), new Date(now));
  f.register({ action: 'watch', label: 'Log', mode: 'idle', idle_file: 'log', idle_seconds: 5 });
  await f.queue.pump(f.options, now + 4000);
  writeFileSync(join(f.root, 'new'), 'replacement');
  utimesSync(join(f.root, 'new'), new Date(now - 100000), new Date(now - 100000));
  renameSync(join(f.root, 'new'), join(f.root, 'log'));
  await f.queue.pump(f.options, now + 5000); assert.equal(f.received.length, 0);
  const resumed = new BackgroundTasks(f.file, f.root);
  await resumed.pump(f.options, now + 9000); assert.equal(f.received.length, 0);
  truncateSync(join(f.root, 'log'), 0); await resumed.pump(f.options, now + 10000);
  await resumed.pump(f.options, now + 15000); assert.equal(f.received[0].status, 'watch_file_idle');
});

test('missing and unreadable files are distinct from inactivity, and paths stay confined', async t => {
  const f = setup(t); f.register({ ...input, idle_file: 'log', idle_seconds: 5 });
  rmSync(join(f.root, 'log'));
  await f.queue.pump(f.options); assert.equal(f.received[0].status, 'watch_file_missing');
  f.register(input);
  rmSync(join(f.root, 'result')); symlinkSync('/etc/hosts', join(f.root, 'result'));
  await f.queue.pump(f.options); assert.equal(f.received[1].status, 'watch_file_unreadable');
  assert.throws(() => f.register(input));
});

test('PID reuse ends the captured process and observation failures remain unknown', async t => {
  let state: 'alive' | 'error' | 'reused' = 'alive';
  const probe: ProcessProbe = () => {
    if (state === 'error') throw Object.assign(new Error('private details'), { code: 'EPERM' });
    return { birth: state === 'alive' ? 'Thu Oct 29 08:00:00 2026' : 'Thu Oct 29 08:01:00 2026', state: 'S' };
  };
  const f = setup(t, probe); f.register({ action: 'watch', label: 'Process', mode: 'process', pid: 123 });
  const now = Date.now(); state = 'error'; await f.queue.pump(f.options, now);
  assert.equal(f.received.length, 0);
  const observed = f.queue.unfinished(target)[0].observed;
  assert.equal('process' in observed ? observed.process : undefined, 'unknown');
  state = 'reused'; await f.queue.pump(f.options, now + 2000);
  assert.equal(f.received[0].status, 'watch_process_reused'); assert.equal(f.received[0].exit_code, undefined);
});

test('process exit code is supplied by a result file, never fabricated from PID loss', async t => {
  let alive = true;
  const probe: ProcessProbe = () => alive ? { birth: 'Thu Oct 29 00:00:00 2026', state: 'S' } : undefined;
  const f = setup(t, probe); writeFileSync(join(f.root, 'result'), 'running');
  f.register({ action: 'watch', label: 'Process', mode: 'process', pid: 123, exit_code_file: 'result' });
  writeFileSync(join(f.root, 'result'), 'exit 9'); alive = false;
  await f.queue.pump(f.options);
  assert.equal(f.received[0].status, 'watch_process_exited'); assert.equal(f.received[0].exit_code, 9);
  assert.equal(f.received[0].exit_code_source, join(f.root, 'result'));
});

test('combined JSON watch retains terminal precedence and restart snapshots do not mutate state', async t => {
  const f = setup(t); writeFileSync(join(f.root, 'result'), '{"status":"running"}');
  f.register({ action: 'watch', label: 'Build', status_file: 'result', field: 'status', terminal: ['done'], idle_file: 'log', idle_seconds: 5 });
  const before = readFileSync(f.file, 'utf8'); f.queue.unfinished(target);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(f.queue.unfinished({ ...target, room: '!other:test' }), []);
  writeFileSync(join(f.root, 'result'), '{"status":"done"}'); await f.queue.pump(f.options);
  assert.equal(f.received[0].status, 'done');
});

test('new watch options are bounded and duplicate specifications are idempotent', t => {
  const f = setup(t); const first = f.register(input); const second = f.register(input);
  assert.equal(first.id, second.id); assert.equal(second.alreadyWatching, true);
  for (const extra of [{ idle_seconds: 0, idle_file: 'log' }, { idle_seconds: 604801, idle_file: 'log' },
    { text_condition: { operator: 'regex', value: '.*' } }, { pid: 123 }, { timeout_hours: 0 }]) assert.throws(() => f.register({ ...input, ...extra }));
  const spec = prepareConditions(input, f.root, Date.now(), () => undefined);
  writeFileSync(join(f.root, 'result'), 'x'.repeat(1025));
  assert.equal(observeConditions(spec, f.root, Date.now(), () => undefined).status, 'watch_file_unreadable');
});

test('a preexisting exit code is not attributed to a new watched process', async t => {
  let alive = true;
  const probe: ProcessProbe = () => alive ? { birth: 'Thu Oct 29 00:00:00 2026', state: 'S' } : undefined;
  const f = setup(t, probe); writeFileSync(join(f.root, 'result'), 'exit 0');
  f.register({ action: 'watch', label: 'Process', mode: 'process', pid: 123, exit_code_file: 'result' });
  alive = false; await f.queue.pump(f.options);
  assert.equal(f.received[0].exit_code, undefined);
});

test('interrupted notification preserves the original text across file changes and restart', async t => {
  const f = setup(t); f.register(input); writeFileSync(join(f.root, 'result'), 'exit 7');
  let original = '';
  await f.queue.pump({ ...f.options, deliver: async (_target, event, admit) => { admit(); original = event.content!.body!; return false; } });
  writeFileSync(join(f.root, 'result'), 'exit 0');
  const resumed = new BackgroundTasks(f.file, f.root);
  await resumed.pump(f.options);
  assert.match(original, /exit 7/); assert.equal(f.received[0].line, 'exit 7');
});

test('a reused PID in zombie state cannot supply the original process exit code', t => {
  const f = setup(t);
  const spec = prepareConditions({ action: 'watch', mode: 'process', pid: 123, exit_code_file: 'result' }, f.root, Date.now(),
    () => ({ birth: 'Thu Oct 29 00:00:00 2026', state: 'S' }));
  writeFileSync(join(f.root, 'result'), 'exit 0');
  const result = observeConditions(spec, f.root, Date.now(), () => ({ birth: 'Thu Oct 29 00:01:00 2026', state: 'Z' }));
  assert.equal(result.status, 'watch_process_reused'); assert.equal(result.exit_code, undefined);
});
