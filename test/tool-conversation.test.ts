import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Bridge, type MatrixEvent } from '../src/bridge.js';
import { BackgroundTasks, type BackgroundTarget } from '../src/background-tasks.js';
import { linkedToolConversation, splitToolConversation, type ToolContext } from '../src/tool-conversation.js';
import { createConfirmationJobs, createRunApprovalJobs } from '../src/decision-jobs.js';
import { PublicationJobs } from '../src/publication-jobs.js';
import type { ApprovalJobOptions } from '../src/approval-jobs.js';
import { DetachedRuns } from '../src/detached-runs.js';
import { bot, owner, peer, home, shared, peerHome, key, signal, event, target, homeTarget, linkedToolsFixture } from './fixtures/linked-tools.js';

const access = { allowed: async () => true, stopping: () => false };
async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('Condition not reached');
}

test('selectors preserve ordinary input and reject forged ownership or invalid destinations', () => {
  const original = { action: 'list' };
  assert.equal(splitToolConversation(original).input, original);
  assert.deepEqual(splitToolConversation({ ...original, conversation: { room: home, thread: null } }),
    { input: original, conversation: { room: home, thread: null } });
  for (const conversation of [null, [], {}, { room: 'alias' }, { room: home, thread: 'bad' },
    { room: home, session: 'replacement' }, { room: home, owner }, { room: home, key },
    { room: home, thread: '$bad\nthread' }]) {
    assert.throws(() => splitToolConversation({ action: 'list', conversation }));
  }
});

test('linked context chooses the correct thread without copying the source message', async t => {
  const f = linkedToolsFixture(t), source = { room: shared, event: event(), key };
  const resolve = (selection: Parameters<typeof linkedToolConversation>[3], from = source) =>
    linkedToolConversation(f.links, bot, from, selection, signal(), access);
  const privateContext = await resolve({ room: home });
  assert.deepEqual(target(privateContext), homeTarget);
  assert.equal(privateContext.event.event_id, undefined);
  assert.equal(privateContext.event.content?.body, undefined);
  assert.equal((await resolve({ room: shared })).event.content?.['m.relates_to']?.event_id, '$shared-thread');
  assert.equal((await resolve({ room: home, thread: null })).event.content?.['m.relates_to'], undefined);
  assert.equal((await resolve({ room: home, thread: '$another' })).event.content?.['m.relates_to']?.event_id, '$another');
  assert.equal((await resolve({ room: shared }, privateContext)).event.content?.['m.relates_to'], undefined);
});

test('linked context rejects other homes, owners, sessions, revoked rooms and cancellation', async t => {
  const f = linkedToolsFixture(t), source = { room: shared, event: event(), key };
  for (const room of [peerHome, '!unlinked:test']) {
    await assert.rejects(linkedToolConversation(f.links, bot, source, { room }, signal(), access));
  }
  for (const from of [{ ...source, room: '!unlinked:test' }, { ...source, key: 'forged' },
    { ...source, event: { ...event(), sender: peer } }]) {
    await assert.rejects(linkedToolConversation(f.links, bot, from, { room: home }, signal(), access));
  }
  for (const denied of [home, shared]) await assert.rejects(linkedToolConversation(f.links, bot, source, { room: home }, signal(),
    { ...access, allowed: async room => room !== denied }));
  for (const change of ['session', 'cancel', 'stop'] as const) {
    f.state.update(key, { codex: 'pinned-session' });
    const controller = new AbortController(); let stopping = false;
    await assert.rejects(linkedToolConversation(f.links, bot, source, { room: home }, controller.signal, {
      allowed: async room => {
        if (room === home) {
          if (change === 'session') f.state.update(key, { codex: 'replacement' });
          if (change === 'cancel') controller.abort();
          if (change === 'stop') stopping = true;
        }
        return true;
      }, stopping: () => stopping,
    }));
  }
});

test('a shared turn updates its existing private timer, preserves its id and delivery across restart', async t => {
  const f = linkedToolsFixture(t);
  const saved = JSON.parse(await f.background.action({ action: 'remind', label: 'Daily check', message: 'Inspect notes',
    deliver: 'room', schedule: { frequency: 'daily', time: '09:00', timezone: 'UTC' } }, homeTarget, signal()));
  const bridge = new Bridge({ botId: bot, owner, kind: 'codex', since: 0, state: f.state, timeoutMs: 5000,
    linkedSession: (room, e) => f.links.key(bot, room, e), isAuthorized: s => s === owner, isPrivateRoom: async () => true,
    toolConversation: (selection, source, s) => linkedToolConversation(f.links, bot, source, selection, s, access),
    background: async (input, context, s) => f.background.action(input, target(context), s),
    report: error => { throw error; }, reply: async room => { assert.equal(room, shared); },
    run: async (_mode, _prompt, _key, s, _sender, _files, _interact, _publish, hooks) => {
      const call = (input: object) => hooks!.background!(input, s);
      assert.deepEqual(JSON.parse(await call({ action: 'list' })), []);
      await assert.rejects(call({ action: 'cancel', id: saved.id }), /No such/);
      const conversation = { room: home };
      assert.equal(JSON.parse(await call({ action: 'list', conversation }))[0].id, saved.id);
      const updated = JSON.parse(await call({ action: 'update', id: saved.id, conversation,
        label: 'Daily check', message: 'Inspect notes', deliver: 'room',
        schedule: { frequency: 'daily', time: '00:00', timezone: 'UTC', interval_minutes: 360, count: 4 } }));
      assert.equal(updated.id, saved.id); assert.equal(updated.room, home);
      assert.equal(JSON.parse(await call({ action: 'list', conversation })).length, 1);
      return 'Updated';
    },
  });
  t.after(() => bridge.stop());
  await bridge.handle(shared, event());
  const reloaded = new BackgroundTasks(f.queueFile, f.dir);
  const rows = JSON.parse(await reloaded.action({ action: 'list' }, homeTarget, signal()));
  assert.equal(rows.length, 1); assert.equal(rows[0].id, saved.id);
  assert.equal(rows[0].schedule.interval_minutes, 360);
  const delivered: BackgroundTarget[] = [];
  await reloaded.pump({ valid: () => true, report: e => { throw e; }, deliver: async () => false,
    post: async (destination, text, admit) => { admit(); delivered.push(destination); assert.equal(text, 'Inspect notes'); return true; },
  }, Date.parse(rows[0].due));
  assert.equal(delivered.length, 1);
  for (const [field, value] of Object.entries(homeTarget)) assert.equal(delivered[0][field as keyof BackgroundTarget], value);
  const context = await linkedToolConversation(f.links, bot, { room: shared, event: event(), key }, { room: home }, signal(), access);
  await reloaded.action({ action: 'cancel', id: saved.id }, target(context), signal());
  assert.deepEqual(JSON.parse(await reloaded.action({ action: 'list' }, homeTarget, signal())), []);
});

test('bridge routes subscriptions and run reads to the selected scope and rejects late hooks', async t => {
  const f = linkedToolsFixture(t), seen: ToolContext[] = [];
  let later!: () => Promise<string>;
  const delegate = async (input: unknown, context: ToolContext) => {
    assert.deepEqual(input, { action: 'list' }); seen.push(context); return '[]';
  };
  const bridge = new Bridge({ botId: bot, kind: 'codex', since: 0, state: f.state, timeoutMs: 5000,
    linkedSession: (room, e) => f.links.key(bot, room, e), isAuthorized: s => s === owner, isPrivateRoom: async () => true,
    toolConversation: (selection, source, s) => linkedToolConversation(f.links, bot, source, selection, s, access),
    github: delegate, detached: delegate, reply: async () => {}, report: e => { throw e; },
    run: async (_mode, _prompt, _key, s, _sender, _files, _interact, _publish, hooks) => {
      const request = { action: 'list', conversation: { room: home } };
      await hooks!.github!(request, s); await hooks!.detached!(request, s);
      later = () => hooks!.github!(request, signal());
      await assert.rejects(hooks!.github!({ action: 'list', conversation: { room: peerHome } }, s));
      return 'Done';
    },
  });
  t.after(() => bridge.stop()); await bridge.handle(shared, event());
  assert.deepEqual(seen.map(target), [homeTarget, homeTarget]);
  await assert.rejects(later()); assert.equal(seen.length, 2);
});

test('a session reset during detached authorization prevents a selected-room mutation', async t => {
  const f = linkedToolsFixture(t);
  let wrote = false;
  const bridge = new Bridge({ botId: bot, kind: 'codex', since: 0, state: f.state, timeoutMs: 5000,
    linkedSession: (room, e) => f.links.key(bot, room, e), isAuthorized: s => s === owner, isPrivateRoom: async () => true,
    toolConversation: (selection, source, s) => linkedToolConversation(f.links, bot, source, selection, s, access),
    detached: async (_input, _context, _signal, _interact, authorize) => {
      f.state.update(key, { codex: 'replacement' });
      await authorize(); wrote = true; return '{}';
    }, reply: async () => {}, report: e => { throw e; },
    run: async (_mode, _prompt, _key, s, _sender, _files, _interact, _publish, hooks) => {
      await assert.rejects(hooks!.detached!({ action: 'stop', id: 'run', conversation: { room: home } }, s));
      f.state.update(key, { codex: 'pinned-session' });
      return 'Done';
    },
  });
  t.after(() => bridge.stop()); await bridge.handle(shared, event());
  assert.equal(wrote, false);
});

test('without linked routing an explicit selector fails before delegated work', async t => {
  const f = linkedToolsFixture(t);
  let delegated = 0;
  const bridge = new Bridge({ botId: bot, kind: 'codex', since: 0, state: f.state, timeoutMs: 5000,
    isAuthorized: s => s === owner, isPrivateRoom: async () => true,
    background: async () => { delegated++; return '[]'; }, reply: async () => {}, report: e => { throw e; },
    run: async (_mode, _prompt, _key, s, _sender, _files, _interact, _publish, hooks) => {
      await assert.rejects(hooks!.background!({ action: 'list', conversation: { room: home } }, s), /linked agent/);
      assert.equal(await hooks!.background!({ action: 'list' }, s), '[]');
      return 'Done';
    },
  });
  t.after(() => bridge.stop()); await bridge.handle(home, event('$home-thread'));
  assert.equal(delegated, 1);
});

for (const kind of ['confirmation', 'publication', 'detached'] as const) test(`${kind} review, decision and notification stay in the selected private conversation`, async t => {
  const f = linkedToolsFixture(t), sent: BackgroundTarget[] = [], notified: BackgroundTarget[] = [];
  const options: Pick<ApprovalJobOptions, 'timeoutMs' | 'valid' | 'authorize' | 'send' | 'notify' | 'report'> = {
    timeoutMs: 5000, valid: destination => f.state.session(destination.key).codex === destination.session,
    authorize: async () => {}, send: async (destination, _request, _text, controls) => { controls.bind('$review'); sent.push(destination); },
    notify: (_id, destination) => { notified.push(destination); }, report: e => { throw e; },
  };
  const runs = new DetachedRuns(join(f.dir, 'runs'), f.dir, { notify() {}, processTable: () => [] });
  const jobs = kind === 'confirmation' ? createConfirmationJobs(join(f.dir, 'jobs.json'), options)
    : kind === 'detached' ? createRunApprovalJobs(join(f.dir, 'jobs.json'), options, runs)
    : new PublicationJobs(join(f.dir, 'jobs.json'), { ...options,
      execute: async (_input, s, interact) => (await interact({ text: 'Publish reviewed commit?',
        approve: { result: 'Published test' }, deny: { result: 'Declined' } }, s) as { result: string }).result });
  let id = '', turn = 0;
  const bridge = new Bridge({ botId: bot, owner, kind: 'codex', since: 0, state: f.state, timeoutMs: 5000,
    linkedSession: (room, e) => f.links.key(bot, room, e), isAuthorized: s => s === owner, isPrivateRoom: async () => true,
    toolConversation: (selection, source, s) => linkedToolConversation(f.links, bot, source, selection, s, access),
    ...(kind === 'confirmation' ? { confirmationJobs: jobs } : kind === 'detached' ? { detachedJobs: jobs,
      detached: (input: unknown, context: ToolContext, s: AbortSignal) => runs.action(input, target(context), s, async () => ({}), async () => {}) }
      : { publications: jobs as PublicationJobs }),
    reply: async () => {}, report: e => { throw e; },
    run: async (_mode, _prompt, _key, s, _sender, _files, _interact, publish, hooks) => {
      const conversation = { room: home };
      if (++turn === 1) {
        const result = JSON.parse(kind === 'confirmation' ? await hooks!.confirmation!({ question: 'Proceed?', conversation }, s)
          : kind === 'detached' ? await hooks!.detached!({ action: 'start', cwd: f.dir, label: 'Check', argv: [process.execPath, '-e', 'process.exit(0)'], conversation }, s)
          : await publish!({ repository: f.dir, remote: 'origin', branch: 'topic', conversation }, s));
        id = result.request_id ?? result.operation_id ?? result.publication_id;
      } else if (kind !== 'publication') {
        const call = kind === 'confirmation' ? hooks!.confirmation! : hooks!.detached!;
        const action = kind === 'confirmation' ? 'status' : 'approval_status';
        await assert.rejects(call({ action, id }, s), /not found/);
        assert.equal(JSON.parse(await call({ action, id, conversation }, s)).state, kind === 'confirmation' ? 'approved' : 'prepared');
      }
      return 'Done';
    },
  });
  t.after(async () => { bridge.stop(); jobs.stop(); await new Promise(r => setImmediate(r)); });
  await bridge.handle(shared, event()); await until(() => sent.length === 1);
  assert.deepEqual(sent, [homeTarget]); assert.equal(bridge.busy, false);
  const reaction = (sender: string, id: string): MatrixEvent => ({ type: 'm.reaction', sender, event_id: id,
    origin_server_ts: Date.now(), content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$review', key: '✅' } } });
  await bridge.handle(shared, reaction(owner, '$wrong-room'));
  await bridge.handle(home, reaction(peer, '$wrong-owner'));
  assert.equal(JSON.parse(jobs.status(homeTarget, id)).state, 'awaiting_approval');
  await bridge.handle(home, reaction(owner, '$approved')); await until(() => notified.length === 1);
  assert.deepEqual(notified, [homeTarget]);
  assert.equal(JSON.parse(jobs.status(homeTarget, id)).state, kind === 'confirmation' ? 'approved' : kind === 'detached' ? 'prepared' : 'succeeded');
  await bridge.handle(shared, event('$shared-thread', '$read-status'));
});
