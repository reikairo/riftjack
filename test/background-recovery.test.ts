import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BackgroundTasks, type BackgroundTarget } from '../src/background-tasks.js';
import { Bridge, sessionKey, type MatrixEvent } from '../src/bridge.js';
import { CodexCyberPolicyError } from '../src/errors.js';
import { State } from '../src/state.js';
import { RunJournal } from '../src/run-journal.js';

const event: MatrixEvent = { type: 'm.room.message', sender: '@alice:test', content: { msgtype: 'm.text', body: 'Check' } };
const target: BackgroundTarget = { room: '!room:test', sender: '@alice:test', key: sessionKey('!room:test', event), session: 'session-1' };
function setup(t: { after(fn: () => void): void }, kind: 'codex' | 'claude' = 'codex', failure = new Error('Backend stopped')) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'riftjack-recovery-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'tasks.json'), state = new State(join(root, 'state.json'));
  state.update(target.key, { [kind]: target.session });
  const queue = new BackgroundTasks(file, root), prompts: string[] = [], replies: string[] = [];
  let fail = true;
  const bridge = new Bridge({ botId: '@bot:test', kind, since: 0, timeoutMs: 10_000, state,
    isAuthorized: () => true, isPrivateRoom: async () => true, report: () => {},
    reply: async (_r, _e, text) => { replies.push(text); },
    run: async (_m, prompt) => { prompts.push(prompt); if (fail) throw failure; return 'NO_REPLY'; },
  });
  const options = { valid: () => true, report: () => {},
    deliver: (to: BackgroundTarget, message: MatrixEvent, admit: () => void, ready: () => boolean, completed: (cancelled?: boolean) => void) =>
      bridge.resumeBackground(to.room, message, to.session, admit, ready, completed) };
  const saved = () => JSON.parse(readFileSync(file, 'utf8')).watches[0];
  return { root, file, state, queue, bridge, prompts, replies, options, saved, succeed: () => { fail = false; } };
}

for (const kind of ['codex', 'claude'] as const) test(`${kind}: failed timer remains recoverable after an admitted backend failure`, async t => {
  const f = setup(t, kind);
  const registered = JSON.parse(f.queue.action({ action: 'remind', label: 'Check', message: 'Inspect existing results.', deliver: 'agent', delay_minutes: 1 }, target, new AbortController().signal));
  const due = Date.parse(registered.due);
  await f.queue.pump(f.options, due);
  assert.equal(f.saved().state, 'interrupted');
  await f.queue.pump(f.options, due);
  assert.equal(f.prompts.length, 1, 'no immediate failure loop');
  f.succeed();
  await new BackgroundTasks(f.file, f.root).pump(f.options, due);
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1]!, /previous.*turn.*not finish/i);
  assert.equal(f.saved().state, 'delivered');
  assert.ok(!f.replies.includes('NO_REPLY'), 'a deliberate silent completion is successful');
  await new BackgroundTasks(f.file, f.root).pump(f.options, due);
  assert.equal(f.prompts.length, 2, 'no repeat after success');
});

test('a watch recovers the observed result even if its status file changes', async t => {
  const f = setup(t);
  writeFileSync(join(f.root, 'status.json'), '{"status":"complete"}');
  f.queue.action({ action: 'watch', label: 'Build', status_file: 'status.json', field: 'status', terminal: ['complete'] }, target, new AbortController().signal);
  await f.queue.pump(f.options);
  assert.equal(f.saved().state, 'interrupted');
  writeFileSync(join(f.root, 'status.json'), '{"status":"running"}');
  f.succeed();
  await new BackgroundTasks(f.file, f.root).pump(f.options);
  assert.match(f.prompts[1]!, /"status":"complete"/);
  assert.equal(f.saved().state, 'delivered');
});

test('a recurring timer recovers the same occurrence before its next scheduled run', async t => {
  const f = setup(t);
  const registered = JSON.parse(f.queue.action({ action: 'remind', label: 'Daily', message: 'Check', deliver: 'agent',
    schedule: { frequency: 'daily', time: '09:00', timezone: 'UTC' } }, target, new AbortController().signal));
  const due = Date.parse(registered.due);
  await f.queue.pump(f.options, due);
  const interrupted = f.saved(), id = interrupted.delivery.id, next = interrupted.expires;
  assert.equal(interrupted.timer.lastRun.due, due);
  assert.ok(next > due);
  f.succeed();
  const received: string[] = [];
  const queue = new BackgroundTasks(f.file, f.root);
  await queue.pump({ ...f.options, deliver: async (to, message, admit, ready, completed) => {
    received.push(message.event_id!); return f.options.deliver(to, message, admit, ready, completed);
  } }, due);
  assert.equal(received[0], id);
  assert.equal(f.saved().expires, next);
  assert.equal(f.saved().timer.lastRun.state, 'delivered');
  await queue.pump(f.options, due);
  assert.equal(f.prompts.length, 2);
  await queue.pump(f.options, next);
  assert.equal(f.prompts.length, 3);
  assert.doesNotMatch(f.prompts[2]!, /Connector recovery/);
});

for (const reason of ['cancel', 'revoke', 'session'] as const) test(`recovery respects ${reason}`, async t => {
  const f = setup(t);
  f.queue.action({ action: 'remind', label: 'Check', message: 'Check', deliver: 'agent', delay_minutes: 1 }, target, new AbortController().signal);
  await f.queue.pump(f.options, f.saved().expires);
  if (reason === 'cancel') f.queue.action({ action: 'cancel', id: f.saved().id }, target, new AbortController().signal);
  if (reason === 'session') f.state.reset(target.key);
  const queue = new BackgroundTasks(f.file, f.root);
  await queue.pump({ ...f.options, valid: () => reason !== 'revoke' && f.state.session(target.key).codex === target.session }, Date.now() + 120_000);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.saved().state, 'cancelled');
});

test('delivery failure after backend success remains recoverable', async t => {
  const f = setup(t);
  f.queue.action({ action: 'remind', label: 'Check', message: 'Check', deliver: 'agent', delay_minutes: 1 }, target, new AbortController().signal);
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 10_000, state: f.state,
    isAuthorized: () => true, isPrivateRoom: async () => true, report: () => {},
    run: async () => 'The result', reply: async () => { throw new Error('Matrix unavailable'); } });
  await f.queue.pump({ ...f.options, deliver: (to, message, admit, ready, completed) =>
    bridge.resumeBackground(to.room, message, to.session, admit, ready, completed) }, f.saved().expires);
  assert.equal(f.saved().state, 'interrupted');
  f.succeed();
  await new BackgroundTasks(f.file, f.root).pump(f.options, Date.now() + 120_000);
  assert.equal(f.saved().state, 'delivered');
});

test('cancel of an active notification is terminal, not a recoverable backend error', async t => {
  const f = setup(t);
  f.queue.action({ action: 'remind', label: 'Check', message: 'Check', deliver: 'agent', delay_minutes: 1 }, target, new AbortController().signal);
  let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 10_000, state: f.state,
    isAuthorized: () => true, isPrivateRoom: async () => true, report: () => {}, reply: async () => {},
    run: async (_m, _p, _k, signal) => { entered(); await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); return ''; } });
  const pumping = f.queue.pump({ ...f.options, deliver: (to, message, admit, ready, completed) =>
    bridge.resumeBackground(to.room, message, to.session, admit, ready, completed) }, f.saved().expires);
  await started;
  await bridge.handle(target.room, { ...event, event_id: '$cancel', origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: '!cancel' } });
  await pumping;
  assert.equal(f.saved().state, 'cancelled');
  await new BackgroundTasks(f.file, f.root).pump(f.options, Date.now() + 120_000);
  assert.equal(f.prompts.length, 0);
});

test('a real process exit after admission preserves the notification for restart', async t => {
  const f = setup(t);
  f.queue.action({ action: 'remind', label: 'Check', message: 'Check', deliver: 'agent', delay_minutes: 1 }, target, new AbortController().signal);
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { BackgroundTasks } from './src/background-tasks.ts';
    import { Bridge } from './src/bridge.ts';
    import { State } from './src/state.ts';
    const root = process.argv[1];
    const queue = new BackgroundTasks(root + '/tasks.json', root);
    const bridge = new Bridge({botId:'@bot:test',kind:'codex',since:0,timeoutMs:10000,state:new State(root+'/state.json'),
      isAuthorized:()=>true,isPrivateRoom:async()=>true,report:()=>{},reply:async()=>{},run:async()=>{process.exit(23);}});
    await queue.pump({valid:()=>true,report:()=>{},deliver:(to,event,admit,ready,completed)=>bridge.resumeBackground(to.room,event,to.session,admit,ready,completed)},Date.now()+120000);
  `, f.root], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 23, child.stderr);
  assert.equal(f.saved().state, 'dispatching');
  f.succeed();
  await new BackgroundTasks(f.file, f.root).pump(f.options, Date.now() + 120_000);
  assert.equal(f.saved().state, 'delivered');
  assert.match(f.prompts[0]!, /Connector recovery after restart/);
});

test('a failed human follow-up does not replay an already completed notification', async t => {
  const f = setup(t), journal = new RunJournal(join(f.root, 'journal.json'));
  f.queue.action({ action: 'remind', label: 'Check', message: 'Check', deliver: 'agent', delay_minutes: 1 }, target, new AbortController().signal);
  let entered!: () => void, release!: () => void, turns = 0;
  const started = new Promise<void>(r => { entered = r; }), wait = new Promise<void>(r => { release = r; });
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 10_000, state: f.state, journal,
    isAuthorized: () => true, isPrivateRoom: async () => true, report: () => {}, reply: async () => {}, steer: async () => false,
    run: async () => {
      if (++turns === 1) { entered(); await wait; return 'Finished'; }
      assert.equal(f.saved().state, 'delivered', 'checkpoint before starting the follow-up');
      throw new Error('Follow-up failed');
    } });
  const pumping = f.queue.pump({ ...f.options, deliver: (to, message, admit, ready, completed) =>
    bridge.resumeBackground(to.room, message, to.session, admit, ready, completed) }, f.saved().expires);
  await started;
  await bridge.handle(target.room, { ...event, event_id: '$followup', origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: 'Another task' } });
  release(); await pumping;
  assert.equal(turns, 2);
  const entries = JSON.parse(readFileSync(join(f.root, 'journal.json'), 'utf8')).entries;
  assert.deepEqual(entries.map((e: any) => e.outcome), ['completed', 'failed']);
  assert.equal(entries[1].event, '$followup');
  assert.equal(f.saved().state, 'delivered');
  await new BackgroundTasks(f.file, f.root).pump(f.options, Date.now() + 120_000);
  assert.equal(f.prompts.length, 0);
});

test('pending recovery cannot be pruned by completed tasks or duplicated by registration', async t => {
  const f = setup(t);
  writeFileSync(join(f.root, 'status.json'), '{"status":"complete"}');
  const input = { action: 'watch', label: 'Build', status_file: 'status.json', field: 'status', terminal: ['complete'] };
  const original = JSON.parse(f.queue.action(input, target, new AbortController().signal));
  await f.queue.pump(f.options);
  assert.equal(JSON.parse(f.queue.action(input, target, new AbortController().signal)).id, original.id);
  for (let i = 0; i < 110; i++) {
    const timer = JSON.parse(f.queue.action({ action: 'remind', label: 'Check', message: 'Check', deliver: 'room', delay_minutes: 1 }, target, new AbortController().signal));
    f.queue.action({ action: 'cancel', id: timer.id }, target, new AbortController().signal);
  }
  f.succeed();
  await new BackgroundTasks(f.file, f.root).pump(f.options);
  assert.equal(f.prompts.length, 2);
});


test('recovered notifications survive a new bridge with a later startup time', async t => {
  const f = setup(t);
  f.queue.action({ action: 'remind', label: 'Check', message: 'Check', deliver: 'agent', delay_minutes: 1 }, target, new AbortController().signal);
  await f.queue.pump(f.options, f.saved().expires);
  let calls = 0;
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: f.saved().delivery.time + 1, timeoutMs: 10_000, state: f.state,
    isAuthorized: () => true, isPrivateRoom: async () => true, report: () => {}, reply: async () => {},
    run: async () => { calls++; return 'NO_REPLY'; } });
  await new BackgroundTasks(f.file, f.root).pump({ ...f.options, deliver: (to, message, admit, ready, completed) =>
    bridge.resumeBackground(to.room, message, to.session, admit, ready, completed) });
  assert.equal(calls, 1);
  assert.equal(f.saved().state, 'delivered');
});

for (const kind of ['codex', 'claude'] as const) test(`${kind}: executor wake is durable, deduplicated and recovers after a failed turn`, async t => {
  const f = setup(t, kind), notification = { group: 'executor:job', progress: false };
  f.queue.notify('executor:result', target, 'Remote job finished. Inspect its log.', notification);
  f.queue.notify('executor:result', target, 'Duplicate', notification);
  await f.queue.pump(f.options);
  assert.equal(f.prompts.length, 1); assert.match(f.prompts[0], /Remote job finished/);
  assert.doesNotMatch(f.prompts[0], /A reminder you scheduled/);
  assert.equal(f.saved().state, 'interrupted');
  f.succeed();
  const recovered = new BackgroundTasks(f.file, f.root);
  recovered.notify('executor:result', target, 'Duplicate after restart', notification);
  await recovered.pump(f.options);
  assert.equal(f.prompts.length, 2); assert.match(f.prompts[1], /Connector recovery/);
  assert.equal(f.saved().state, 'delivered');
  await recovered.pump(f.options); assert.equal(f.prompts.length, 2);
});

test('executor progress coalesces while busy and completion supersedes pending updates', async t => {
  const f = setup(t); f.succeed();
  const group = 'executor:job';
  f.queue.notify('p1', target, 'First progress', { group, progress: true });
  await f.queue.pump({ ...f.options, deliver: async () => false });
  f.queue.notify('p2', target, 'Latest progress', { group, progress: true });
  f.queue.notify('p1', target, 'Duplicate old progress', { group, progress: true });
  await f.queue.pump(f.options);
  assert.equal(f.prompts.length, 1); assert.match(f.prompts[0], /Latest progress/);
  f.queue.notify('p3', target, 'Pending progress', { group, progress: true });
  f.queue.notify('done', target, 'Completed', { group, progress: false });
  const recovered = new BackgroundTasks(f.file, f.root);
  await recovered.pump(f.options);
  assert.equal(f.prompts.length, 2); assert.match(f.prompts[1], /Completed/);
});

test('Astra skips only the stopped fragment and resumes the same pass across restart', async t => {
  const f = setup(t, 'codex', new CodexCyberPolicyError('Stopped', 'provider private detail'));
  const units = [{ file: 'src/read.ts', start_line: 1, end_line: 30 },
    { file: 'src/read.ts', start_line: 31, end_line: 90 }, { file: 'src/write.ts' }];
  const label = 'Review error handling', signal = new AbortController().signal;
  const registered = JSON.parse(f.queue.action({ action: 'astra_review', label, units }, target, signal));
  assert.equal(registered.schedule.interval_seconds, 1);
  await f.queue.pump(f.options, Date.parse(registered.due));
  assert.equal(f.saved().state, 'waiting');
  assert.equal(f.saved().timer.lastRun.state, 'skipped');
  assert.equal(f.saved().delivery, undefined);
  assert.doesNotMatch(JSON.stringify(f.saved()), /provider private detail/);

  const restored = new BackgroundTasks(f.file, f.root);
  const [live] = JSON.parse(restored.action({ action: 'list' }, target, signal));
  assert.deepEqual(live.review, { pass: label, processed: 1, total: 3, next: units[1],
    notes: [{ ...units[0], reason: 'cyberPolicy', status: 'skipped' }] });
  f.succeed();
  await restored.pump(f.options, Date.parse(live.due));
  const payload = (i: number) => JSON.parse(f.prompts[i]!.split('\n').at(-1)!);
  assert.equal(payload(1).label, label);
  assert.match(payload(1).message, /Заведи про это заметку и продолжи без глубокого анализа этой проблемы\./);
  assert.ok(payload(1).message.endsWith(JSON.stringify(units[1])));
  await restored.pump(f.options, f.saved().expires);
  assert.ok(payload(2).message.endsWith(JSON.stringify(units[2])));
  assert.doesNotMatch(payload(2).message, /Заведи/);
  await new BackgroundTasks(f.file, f.root).pump(f.options, f.saved().expires + 10000);
  assert.equal(f.prompts.length, 3);
  const [done] = JSON.parse(restored.action({ action: 'history' }, target, signal)).items;
  assert.equal(done.state, 'delivered');
  assert.equal(done.due, null);
  assert.equal(done.review.processed, 3);
  assert.deepEqual(done.review.notes, live.review.notes);
});

test('Astra closes on a final policy stop and never advances on a lookalike error', async t => {
  for (const policy of [true, false]) {
    const f = setup(t, 'codex', policy ? new CodexCyberPolicyError('Stopped', '') : new Error('cyberPolicy'));
    f.queue.action({ action: 'astra_review', label: 'Review timing', units: [{ file: 'clock.ts' }] }, target, new AbortController().signal);
    await f.queue.pump(f.options, f.saved().expires);
    assert.equal(f.saved().state, policy ? 'delivered' : 'interrupted');
    assert.equal(f.saved().timer.review.cursor, policy ? 1 : 0);
    assert.deepEqual(f.saved().timer.review.skipped, policy ? [0] : []);
    await new BackgroundTasks(f.file, f.root).pump(f.options, f.saved().expires + 5000);
    assert.equal(f.prompts.length, 1);
  }
});

test('Astra rejects overlapping ranges, duplicate files and incomplete units', t => {
  const f = setup(t);
  for (const units of [[], [{ file: 'f' }, { file: 'f' }], [{ file: '../f' }], [{ file: 'f', end_line: 3 }],
    [{ file: 'f', start_line: 1, end_line: 4 }, { file: 'f', start_line: 4, end_line: 7 }]]) {
    assert.throws(() => f.queue.action({ action: 'astra_review', label: 'Review', units }, target, new AbortController().signal), /independent units/);
  }
});

test('a regular reminder retains its interrupted state on a structured policy stop', async t => {
  const f = setup(t, 'codex', new CodexCyberPolicyError('Stopped', ''));
  f.queue.action({ action: 'remind', label: 'Check', message: 'Check the build.', deliver: 'agent',
    schedule: { frequency: 'interval', interval_seconds: 1 } }, target, new AbortController().signal);
  await f.queue.pump(f.options, f.saved().expires);
  assert.equal(f.saved().state, 'interrupted');
  assert.equal(f.saved().timer.lastRun.state, 'interrupted');
  await f.queue.pump(f.options, f.saved().expires + 2000);
  assert.equal(f.prompts.length, 1);
});
