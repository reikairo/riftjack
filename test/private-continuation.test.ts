import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationLinks } from '../src/conversation-links.js';
import { linkedRoomMessages, roomMessageDelivery } from '../src/room-messages.js';
import { BackgroundTasks, type BackgroundTarget } from '../src/background-tasks.js';
import { DeliveryReceipts } from '../src/delivery-receipts.js';
import { Bridge, type MatrixEvent } from '../src/bridge.js';
import { State } from '../src/state.js';

const bot = '@builder:test', owner = '@alice:test', peer = '@reviewer:test';
const home = '!home:test', shared = '!shared:test';
const key = JSON.stringify([home, owner, '$home-thread']);
const signal = new AbortController().signal;
const request = { action: 'continue_private', id: 'review-next', text: 'Inspect the completed review and request the remaining check.' } as const;
const event = (body = 'Review this change', id = '$source'): MatrixEvent => ({ type: 'm.room.message', event_id: id,
  sender: owner, origin_server_ts: Date.now(), content: { msgtype: 'm.text', body,
    'm.relates_to': { rel_type: 'm.thread', event_id: '$shared-thread' } } });
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'private-continuation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new State(join(dir, 'state.json'));
  state.update(key, { codex: 'pinned-session' });
  const config = { version: 1, agents: [{ bot, owner, home, session: 'pinned-session', thread: '$home-thread' }],
    rooms: [{ room: shared, owner, bots: [bot, peer] }] };
  writeFileSync(join(dir, 'links.json'), JSON.stringify(config));
  const links = new ConversationLinks(join(dir, 'links.json'), join(dir, 'history.json'),
    [{ userId: bot, kind: 'codex', name: 'Builder', accessToken: 'test' }], state, owner);
  const queueFile = join(dir, 'background.json'), background = new BackgroundTasks(queueFile, dir);
  return { dir, state, links, queueFile, background };
}

test('private continuation is durable, idempotent and routes approval and replies to the pinned home thread', async t => {
  const f = fixture(t), receiptFile = join(f.dir, 'receipts.json');
  const source = event();
  const scope = { room: shared, sender: owner, thread: '$shared-thread', key, session: 'pinned-session' };
  let queued = 0;
  const make = () => roomMessageDelivery(linkedRoomMessages(f.links, bot, { room: shared, event: source, key }, {
    allowed: async () => true, stopping: () => false,
    send: async () => { throw new Error('No Matrix message should be sent to trigger continuation'); },
    continuePrivate: (id, target, note) => {
      queued++;
      assert.deepEqual(target, { room: home, sender: owner, key, session: 'pinned-session', thread: '$home-thread' });
      assert.match(note, /not a new human request or approval/);
      assert.equal(JSON.parse(note.split('\n')[1]).source_event, '$source');
      f.background.notify(id, target, note, { group: id, progress: false }, 'Private task continuation');
    },
  }), () => new DeliveryReceipts(receiptFile).scoped(scope, 'rooms'));
  const result = JSON.parse(await make()(request, signal));
  assert.equal(result.status, 'queued');
  assert.equal(JSON.parse(await make()(request, signal)).continuation_id, result.continuation_id);
  assert.equal(queued, 1);
  const receipt = JSON.parse(await make()({ action: 'status', id: request.id }, signal));
  assert.equal(receipt.status, 'sent'); assert.equal(receipt.result.status, 'queued');
  await assert.rejects(make()({ ...request, text: 'Different task' }, signal), /different content/);
  const destinations: string[] = [];
  let runs = 0;
  const destination = (room: string, e: MatrixEvent) => {
    destinations.push(room); assert.equal(room, home);
    assert.equal(e.content?.['m.relates_to']?.event_id, '$home-thread');
  };
  const bridge = new Bridge({ botId: bot, owner, kind: 'codex', since: 0, state: f.state, timeoutMs: 2000,
    linkedSession: (room, e) => f.links.key(bot, room, e), isAuthorized: sender => sender === owner,
    isPrivateRoom: async () => true, report: error => { throw error; },
    reply: async (room, e) => destination(room, e),
    confirmation: async (room, e, _text, controls) => {
      destination(room, e); controls.bind('$confirmation');
      await bridge.handle(room, { type: 'm.reaction', sender: owner, event_id: '$decline', origin_server_ts: Date.now(),
        content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$confirmation', key: '❌' } } });
    },
    run: async (_mode, prompt, backendKey, s, _sender, _files, interact, _publish, hooks) => {
      runs++; assert.equal(backendKey, key); assert.match(prompt, /own handoff note/);
      await hooks!.progress!('Checking saved results');
      assert.deepEqual(await interact!({ text: 'Run the check?', approve: { allowed: true }, deny: { allowed: false } }, s), { allowed: false });
      return 'Check was declined';
    },
  });
  t.after(() => bridge.stop());
  const reloaded = new BackgroundTasks(f.queueFile, f.dir);
  const pump = () => reloaded.pump({ valid: target => f.state.session(target.key).codex === target.session,
    report: error => { throw error; },
    deliver: (target, e, admitted, ready, completed) => bridge.resumeBackground(target.room, e, target.session, admitted, ready, completed) });
  await pump(); await pump();
  assert.equal(runs, 1); assert.equal(destinations.length, 4);
  assert.equal(f.links.peerCredit(bot), 0);
});

test('private continuation rejects private/unlinked sources, forged scope and revoked access', async t => {
  const f = fixture(t);
  let queued = 0, live = true;
  const make = (room = shared, source = event(), sourceKey = key) => roomMessageDelivery(linkedRoomMessages(f.links, bot,
    { room, event: source, key: sourceKey }, { allowed: async () => live, stopping: () => false,
      send: async () => 'unused', continuePrivate: () => { queued++; } }));
  for (const action of [make(home), make('!unlinked:test'), make(shared, { ...event(), sender: peer }), make(shared, event(), 'wrong')]) {
    await assert.rejects(action(request, signal));
  }
  for (const extra of [{ room: home }, { sender: owner }, { session: 'new' }, { thread: '$other' }, { mentions: [peer] }]) {
    await assert.rejects(make()({ ...request, ...extra }, signal));
  }
  live = false; await assert.rejects(make()(request, signal));
  assert.equal(queued, 0);
});

test('session replacement or cancellation during destination authorization prevents queueing', async t => {
  for (const change of ['session', 'cancel'] as const) {
    const f = fixture(t), controller = new AbortController();
    const action = linkedRoomMessages(f.links, bot, { room: shared, event: event(), key }, {
      allowed: async room => {
        if (room === home) {
          if (change === 'session') f.state.update(key, { codex: 'replacement' });
          else controller.abort();
        }
        return true;
      }, stopping: () => false, send: async () => 'unused',
      continuePrivate: () => assert.fail('must not queue'),
    });
    await assert.rejects(action(request, controller.signal));
  }
});

test('a turn allows only one continuation and bounds its handoff text', async () => {
  let calls = 0;
  const action = roomMessageDelivery(async () => { calls++; return '{"status":"queued"}'; });
  for (const text of ['', ' ', '界'.repeat(1001), 'bad\u0000note']) await assert.rejects(action({ ...request, text }, signal));
  await Promise.all([action(request, signal), action(request, signal)]);
  await assert.rejects(action({ ...request, id: 'second' }, signal), /Only one/);
  assert.equal(calls, 1);
});

test('identical request ids in separate source threads do not collapse their continuations', async t => {
  const f = fixture(t), ids = new Set<string>();
  for (const thread of ['$first', '$second']) {
    const source = event();
    source.content!['m.relates_to'] = { rel_type: 'm.thread', event_id: thread };
    const action = linkedRoomMessages(f.links, bot, { room: shared, event: source, key }, {
      allowed: async () => true, stopping: () => false, send: async () => 'unused',
      continuePrivate: id => { ids.add(id); },
    });
    await action(request, signal);
  }
  assert.equal(ids.size, 2);
});

test('a queued continuation waits for the source turn and explicit source cancellation removes it', async t => {
  for (const cancel of [false, true]) {
    const f = fixture(t);
    let registered!: () => void, finish!: () => void;
    const registration = new Promise<void>(r => { registered = r; });
    const finishing = new Promise<void>(r => { finish = r; });
    let runs = 0;
    const bridge = new Bridge({ botId: bot, owner, kind: 'codex', since: 0, state: f.state, timeoutMs: 2000,
      linkedSession: (room, e) => f.links.key(bot, room, e), isAuthorized: () => true, isPrivateRoom: async () => true,
      report: () => {}, reply: async () => {},
      roomMessages: (r, context, s) => linkedRoomMessages(f.links, bot, context, {
        allowed: async () => true, stopping: () => false, send: async () => 'unused',
        continuePrivate: (id, target, note) => {
          f.background.notify(id, target, note, { group: id, progress: false });
          context.onCancel(() => f.background.cancelNotifications(id, target));
        },
      })(r, s),
      run: async (_mode, _prompt, _key, _s, _sender, _files, _interact, _publish, hooks) => {
        if (++runs === 1) {
          await hooks!.roomMessages!(request, signal); registered(); await finishing;
          return 'Continuing privately';
        }
        return 'Private result';
      },
    });
    t.after(() => bridge.stop());
    const turn = bridge.handle(shared, event());
    await registration;
    const pump = () => f.background.pump({ valid: () => true, report: error => { throw error; },
      deliver: (target, e, admitted, ready, completed) => bridge.resumeBackground(target.room, e, target.session, admitted, ready, completed) });
    await pump(); assert.equal(runs, 1);
    if (cancel) await bridge.handle(shared, event('!cancel', '$cancel'));
    finish(); await turn; await pump();
    assert.equal(runs, cancel ? 1 : 2);
  }
});

test('pending continuations do not enter a replaced session or a non-private destination', async t => {
  for (const revoke of ['session', 'privacy'] as const) {
    const f = fixture(t);
    const target: BackgroundTarget = { room: home, sender: owner, key, session: 'pinned-session', thread: '$home-thread' };
    f.background.notify('continuation:test', target, 'Existing task note', { group: 'test', progress: false });
    if (revoke === 'session') f.state.update(key, { codex: 'replacement' });
    const bridge = new Bridge({ botId: bot, kind: 'codex', since: 0, state: f.state, timeoutMs: 2000,
      linkedSession: (room, e) => f.links.key(bot, room, e), isAuthorized: () => true, isPrivateRoom: async () => false,
      report: error => { throw error; }, reply: async () => assert.fail('no delivery'), run: async () => assert.fail('no run') });
    t.after(() => bridge.stop());
    await f.background.pump({ valid: t => f.state.session(t.key).codex === t.session, report: error => { throw error; },
      deliver: (t, e, admitted, ready, completed) => bridge.resumeBackground(t.room, e, t.session, admitted, ready, completed) });
  }
});
