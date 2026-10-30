import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicationJobs } from '../src/publication-jobs.js';
import { BackgroundTasks, type BackgroundTarget } from '../src/background-tasks.js';
import { Bridge, type MatrixEvent } from '../src/bridge.js';
import { State } from '../src/state.js';

const target: BackgroundTarget = { room: '!room:test', sender: '@alice:test', key: 'conversation', session: 'session', thread: '$thread' };
const input = { repository: '.', remote: 'origin', branch: 'main' };
const deferred = () => { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() }; };
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('Condition not reached'); }
function fixture(t: { after(fn: () => void): void }, timeoutMs = 10000) {
  const dir = mkdtempSync(join(tmpdir(), 'publication-jobs-'));
  const path = join(dir, 'jobs.json');
  const notifications: string[] = [], errors: unknown[] = [];
  const background = new BackgroundTasks(join(dir, 'background.json'), dir);
  const delivered = deferred();
  let valid = true, allowed = true, pushes = 0, confirmationId = '', confirmationEvent = '';
  const options: ConstructorParameters<typeof PublicationJobs>[1] = {
    timeoutMs, valid: () => valid,
    authorize: async () => { if (!allowed) throw new Error('privacy changed'); },
    execute: async (_input, signal, interact, authorize) => {
      const decision = await interact({ text: 'Publish reviewed commit?', approve: { publish: true }, deny: { publish: false } }, signal);
      if (!('publish' in decision) || !decision.publish) return 'Publication declined. No push was made.';
      await authorize(); signal.throwIfAborted(); pushes++;
      return 'Published reviewed-sha to origin/main.';
    },
    send: async (_target, _request, text, controls) => {
      confirmationId = /^Confirmation (\w+)/.exec(text)![1];
      confirmationEvent = '$confirmation'; controls.bind(confirmationEvent); delivered.resolve();
    },
    notify: (id, target, message) => {
      background.notify(id, target, message, { group: id, progress: false }, 'Publication result');
      notifications.push(message);
    },
    report: error => { errors.push(error); },
  };
  const jobs = new PublicationJobs(path, options);
  t.after(async () => { jobs.stop(); await new Promise(resolve => setImmediate(resolve)); rmSync(dir, { recursive: true, force: true }); });
  return { jobs, options, path, dir, background, notifications, errors, delivered,
    get pushes() { return pushes; }, get confirmationId() { return confirmationId; }, get confirmationEvent() { return confirmationEvent; },
    valid: (v: boolean) => { valid = v; }, allowed: (v: boolean) => { allowed = v; },
    records: () => JSON.parse(readFileSync(path, 'utf8')).jobs,
  };
}

test('publication survives its submitting signal, accepts a later approval and persists a deduplicated result', async t => {
  const f = fixture(t), turn = new AbortController();
  const receipt = JSON.parse(await f.jobs.start(input, target, turn.signal));
  assert.equal(receipt.status, 'preparing'); assert.ok(receipt.publication_id);
  turn.abort();
  await f.delivered.promise;
  assert.equal(f.pushes, 0);
  await f.jobs.answer(target, '!approve');
  await until(() => f.notifications.length === 1);
  assert.equal(f.pushes, 1);
  assert.equal(f.records()[0].state, 'succeeded');
  f.jobs.pump(); assert.equal(f.notifications.length, 1);
  // Simulate a crash after queueing the result but before recording the receipt.
  const records = f.records(); records[0].notified = false;
  writeFileSync(f.path, JSON.stringify({ version: 1, jobs: records }));
  const recovered = new PublicationJobs(f.path, f.options); recovered.pump();
  const saved = JSON.parse(readFileSync(join(f.dir, 'background.json'), 'utf8'));
  assert.equal(saved.watches.length, 1);
  assert.equal(f.pushes, 1);
});

test('approval is isolated by room, sender, thread, conversation and session; duplicate starts are refused', async t => {
  const f = fixture(t);
  await f.jobs.start(input, target, new AbortController().signal); await f.delivered.promise;
  for (const field of ['room', 'sender', 'thread', 'key', 'session'] as const) {
    assert.equal(await f.jobs.answer({ ...target, [field]: 'other' }, '!approve ' + f.confirmationId), undefined);
  }
  assert.equal(await f.jobs.react('!else:test', target.sender, f.confirmationEvent, '✅', () => true), undefined);
  assert.equal(await f.jobs.react(target.room, '@other:test', f.confirmationEvent, '✅', () => true), undefined);
  await assert.rejects(f.jobs.start(input, target, new AbortController().signal), /already pending/);
  await f.jobs.answer(target, '!deny'); await until(() => f.notifications.length === 1);
  assert.equal(f.pushes, 0); assert.equal(f.records()[0].state, 'declined');
});

for (const mode of ['cancel', 'revoke', 'session', 'privacy', 'timeout'] as const) test(`${mode} prevents a pending publication`, async t => {
  const f = fixture(t, mode === 'timeout' ? 30 : 10000);
  await f.jobs.start(input, target, new AbortController().signal); await f.delivered.promise;
  if (mode === 'cancel') f.jobs.cancel(target);
  if (mode === 'revoke') f.jobs.revoke(target.sender);
  if (mode === 'session') { f.valid(false); f.jobs.pump(); }
  if (mode === 'privacy') { f.allowed(false); await assert.rejects(f.jobs.answer(target, '!approve')); f.jobs.cancel(target); }
  await until(() => !['preparing', 'awaiting_approval', 'publishing'].includes(f.records()[0].state));
  assert.equal(await f.jobs.answer(target, '!approve ' + f.confirmationId), undefined);
  assert.equal(f.pushes, 0);
  if (mode !== 'timeout') assert.equal(f.notifications.length, 0);
  else await until(() => f.notifications.length === 1);
});

test('restart interrupts pending work without restoring approval or replaying push', async t => {
  const f = fixture(t);
  await f.jobs.start(input, target, new AbortController().signal); await f.delivered.promise;
  const snapshot = readFileSync(f.path, 'utf8');
  f.jobs.cancel(target); await until(() => f.records()[0].state === 'cancelled');
  writeFileSync(f.path, snapshot);
  const recovered = new PublicationJobs(f.path, f.options);
  assert.equal(await recovered.answer(target, '!approve ' + f.confirmationId), undefined);
  recovered.pump(); assert.equal(f.records()[0].state, 'interrupted');
  assert.match(f.notifications[0], /restarted/); assert.equal(f.pushes, 0);
});

test('failed result delivery is retried from saved outcome without running publication again', async t => {
  const f = fixture(t); let failing = true;
  const notify = f.options.notify;
  f.options.notify = (...args) => { if (failing) throw new Error('queue unavailable'); notify(...args); };
  await f.jobs.start(input, target, new AbortController().signal); await f.delivered.promise;
  await f.jobs.answer(target, '!approve'); await until(() => f.records()[0].state === 'succeeded');
  assert.equal(f.notifications.length, 0); assert.equal(f.pushes, 1);
  failing = false; f.jobs.pump(); assert.equal(f.notifications.length, 1); assert.equal(f.pushes, 1);
});

test('escaped publication diagnostics fit in the durable notification and retain the full saved result', async t => {
  const f = fixture(t);
  const result = 'Published ' + '"\\\n'.repeat(2000);
  f.options.execute = async () => result;
  await f.jobs.start(input, target, new AbortController().signal);
  await until(() => f.notifications.length === 1);
  assert.equal(f.records()[0].result, result);
  assert.ok(f.notifications[0].length <= 4000);
  assert.match(f.notifications[0], /"truncated":true/);
  assert.equal(f.errors.length, 0);
});

test('shutdown aborts every pending operation even if saving its state fails', async t => {
  const f = fixture(t);
  await f.jobs.start(input, target, new AbortController().signal); await f.delivered.promise;
  await f.jobs.start(input, { ...target, thread: '$second' }, new AbortController().signal);
  await until(() => f.jobs.count({ ...target, thread: '$second' }) === 1);
  // A directory at the temporary-file path makes writes fail without depending on permissions.
  const { mkdirSync } = await import('node:fs'); mkdirSync(f.path + '.tmp');
  assert.doesNotThrow(() => f.jobs.stop());
  assert.equal(await f.jobs.answer(target, '!approve'), undefined);
  assert.equal(await f.jobs.answer({ ...target, thread: '$second' }, '!approve'), undefined);
  assert.equal(f.pushes, 0);
  assert.ok(f.errors.length >= 2);
});

test('bridge routes approvals after the model turn ends, while preserving other confirmation scopes', async t => {
  const f = fixture(t); const state = new State(join(f.dir, 'state.json')); state.update(target.key, { codex: target.session });
  const replies: string[] = [], prompts: string[] = [];
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 10000, state, publications: f.jobs,
    isAuthorized: s => s === target.sender, isPrivateRoom: async () => true, linkedSession: () => target.key,
    reply: async (_r, _e, text) => { replies.push(text); }, report: error => { throw error; },
    run: async (_m, prompt, _k, signal, _s, _a, _i, publish) => { prompts.push(prompt); if (prompts.length === 1) await publish!(input, signal); return 'Handled.'; },
  });
  const event = (body: string, id: string, thread = target.thread): MatrixEvent => ({ type: 'm.room.message', event_id: id, sender: target.sender,
    origin_server_ts: Date.now(), content: { body, msgtype: 'm.text', 'm.relates_to': { rel_type: 'm.thread', event_id: thread } } });
  await bridge.handle(target.room, event('Publish it', '$request')); await f.delivered.promise;
  assert.equal(bridge.busy, false);
  await bridge.handle(target.room, event('!approve', '$wrong-thread', '$else'));
  assert.equal(f.pushes, 0);
  await bridge.handle(target.room, event('!approve', '$approve'));
  await until(() => f.notifications.length === 1); assert.equal(f.pushes, 1);
  await f.background.pump({ valid: () => true,
    deliver: (target, event, admitted, ready, completed) => bridge.resumeBackground(target.room, event, target.session, admitted, ready, completed),
    post: async () => false, report: error => { throw error; },
  });
  assert.equal(prompts.length, 2); assert.match(prompts[1], /publication.*succeeded/);
});


test('bridge routes publication reactions while idle and explicit cancel does not start another turn', async t => {
  for (const cancel of [false, true]) {
    const f = fixture(t); const state = new State(join(f.dir, 'state.json')); state.update(target.key, { codex: target.session });
    const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 10000, state, publications: f.jobs,
      isAuthorized: s => s === target.sender, isPrivateRoom: async () => true, linkedSession: () => target.key,
      reply: async () => {}, report: error => { throw error; }, run: async () => assert.fail('No model turn expected'),
    });
    await f.jobs.start(input, target, new AbortController().signal); await f.delivered.promise;
    if (cancel) await bridge.handle(target.room, { type: 'm.room.message', event_id: '$cancel', sender: target.sender,
      origin_server_ts: Date.now(), content: { body: '!cancel', msgtype: 'm.text', 'm.relates_to': { rel_type: 'm.thread', event_id: target.thread } } });
    await bridge.handle(target.room, { type: 'm.reaction', event_id: '$reaction', sender: target.sender, origin_server_ts: Date.now(),
      content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: f.confirmationEvent, key: '✅' } } });
    if (!cancel) { await until(() => f.notifications.length === 1); assert.equal(f.pushes, 1); }
    else { await until(() => f.records()[0].state === 'cancelled'); assert.equal(f.pushes, 0); assert.equal(f.notifications.length, 0); }
  }
});

test('bare approval cannot choose between a publication and a live command confirmation', async t => {
  const f = fixture(t), commandShown = deferred();
  const state = new State(join(f.dir, 'state.json')); state.update(target.key, { codex: target.session });
  const replies: string[] = []; let commandApproved = false;
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 10000, state, publications: f.jobs,
    isAuthorized: s => s === target.sender, isPrivateRoom: async () => true, linkedSession: () => target.key,
    reply: async (_room, _event, text) => { replies.push(text); }, report: error => { throw error; },
    confirmation: async (_room, _event, _text, controls) => { controls.bind('$command'); commandShown.resolve(); },
    run: async (_m, _p, _k, signal, _s, _a, interact) => {
      const result = await interact!({ text: 'Execute a command?', approve: { yes: true }, deny: { yes: false } }, signal);
      commandApproved = 'yes' in result && result.yes === true; return 'Done';
    },
  });
  const message = (body: string, id: string): MatrixEvent => ({ type: 'm.room.message', event_id: id, sender: target.sender,
    origin_server_ts: Date.now(), content: { body, msgtype: 'm.text', 'm.relates_to': { rel_type: 'm.thread', event_id: target.thread } } });
  await f.jobs.start(input, target, new AbortController().signal); await f.delivered.promise;
  const running = bridge.handle(target.room, message('Run a command', '$task')); await commandShown.promise;
  await bridge.handle(target.room, message('!approve', '$ambiguous'));
  assert.match(replies.at(-1)!, /More than one confirmation/); assert.equal(commandApproved, false); assert.equal(f.pushes, 0);
  await bridge.handle(target.room, message('!approve ' + f.confirmationId, '$specific'));
  await until(() => f.notifications.length === 1); assert.equal(f.pushes, 1); assert.equal(commandApproved, false);
  await bridge.handle(target.room, message('!deny', '$deny-command')); await running;
  assert.equal(commandApproved, false);
});

test('submission cancelled during admission creates no operation, while an admitted operation persists', async t => {
  const f = fixture(t), permission = deferred();
  f.options.authorize = () => permission.promise;
  const turn = new AbortController();
  const pending = f.jobs.start(input, target, turn.signal);
  turn.abort(); permission.resolve();
  await assert.rejects(pending); assert.equal(f.pushes, 0); assert.equal(f.notifications.length, 0);
  assert.equal(f.jobs.summary(target), '');
});
