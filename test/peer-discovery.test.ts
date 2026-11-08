import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationLinks, PEER_EVENT, PEER_FIELD } from '../src/conversation-links.js';
import { PeerDiscovery, type DiscoveryEvent } from '../src/peer-discovery.js';
import { State } from '../src/state.js';
import { sessionKey, type MatrixEvent, GRANT } from '../src/bridge.js';
import { WorkerBridge } from '../src/worker-bridge.js';
import { WorkerService } from '../src/worker-service.js';
import { WorkerQueue } from '../src/worker-queue.js';
import { WorkerMatrixClient } from '../src/worker-matrix-client.js';
import { SimpleFsStorageProvider } from '@vector-im/matrix-bot-sdk';
import { linkedRoomMessages } from '../src/room-messages.js';

const owner = '@alice:test', a = '@builder:test', b = '@worker:test', room = '!shared:test';
const message = (sender: string, id: string, content: any): MatrixEvent => ({ type: 'm.room.message', sender, event_id: id, origin_server_ts: Date.now(), content });
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'peer-discovery-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.now(), serial = 0;
  let members = [owner, a, b].map(id => ({ type: 'm.room.member', state_key: id, event_id: '$join-' + id,
    origin_server_ts: now - 1000, content: { membership: 'join' } }));
  let privacy = true;
  const roomState = () => [
    { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
    { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: privacy ? 'joined' : 'shared' } }, ...members,
  ];
  function instance(bot: string, kind: 'codex' | 'grok') {
    const home = '!home-' + kind + ':test', key = sessionKey(home, { sender: owner });
    const state = new State(join(dir, kind + '-sessions.json')); state.update(key, { [kind]: kind + '-session' });
    const config = { version: 1, agents: [{ bot, owner, home, session: kind + '-session' }], rooms: [{ room, owner, bots: [bot] }] };
    const file = join(dir, kind + '-links.json'), history = join(dir, kind + '-history.json'); writeFileSync(file, JSON.stringify(config));
    const load = () => new ConversationLinks(file, history, [{ userId: bot, kind, name: kind, accessToken: 'test' }], state, owner);
    let links = load(), stopped = false;
    const outgoing: DiscoveryEvent[] = [];
    const allowed = (target: string, sender: string) => links.allowed(bot, target, sender, async () => roomState());
    const create = () => new PeerDiscovery(links, bot, { allowed, stopping: () => stopped, report: error => { throw error; },
      send: async (_room, type, content) => { outgoing.push({ type, content, sender: bot, event_id: '$protocol' + ++serial, origin_server_ts: now }); },
    }, () => now);
    let discovery = create();
    return { bot, home, key, state, file, config, outgoing, allowed, get links() { return links; }, get discovery() { return discovery; },
      restart() { links = load(); discovery = create(); }, stop() { stopped = true; } };
  }
  const left = instance(a, 'codex'), right = instance(b, 'grok');
  const introduce = async () => {
    await left.discovery.pump(); const request = left.outgoing.shift()!;
    await right.discovery.receive(room, request); const response = right.outgoing.shift()!;
    await left.discovery.receive(room, response);
  };
  return { dir, left, right, introduce, roomState, advance(ms: number) { now += ms; },
    leave(id: string) { members = members.filter(m => m.state_key !== id); },
    rejoin(id: string) { now += 1000; members.push({ type: 'm.room.member', state_key: id, event_id: '$rejoin-' + id,
      origin_server_ts: now, content: { membership: 'join' } }); },
    deny() { privacy = false; }, get now() { return now; } };
}

test('two independent instances discover peers without copying accounts, sessions or peer IDs', async t => {
  const f = fixture(t); await f.introduce();
  assert.deepEqual(f.left.config.rooms[0].bots, [a]); assert.deepEqual(f.right.config.rooms[0].bots, [b]);
  assert.deepEqual(f.left.links.bots(a, room), [a, b]); assert.deepEqual(f.right.links.bots(b, room), [b, a]);
  assert.equal(f.left.links.peerCredit(a), 0); assert.equal(f.right.links.peerCredit(b), 0);
  assert.equal(f.left.outgoing.length, 0); assert.equal(f.right.outgoing.length, 0); // No response loop.
  f.left.restart(); assert.deepEqual(f.left.links.bots(a, room), [a]);
  await f.left.allowed(room, owner); assert.deepEqual(f.left.links.bots(a, room), [a, b]);
  const prompt = f.left.links.prompt(a, room, message(owner, '$human', { msgtype: 'm.text', body: 'hello' }), 'hello');
  assert.deepEqual(JSON.parse(prompt.split('\n')[1]).participants, [owner, a, b]);
  assert.doesNotMatch(prompt, /\$protocol|org\.riftjack\.peer/);
  const action = linkedRoomMessages(f.left.links, a, { room, event: message(owner, '$turn', {}), key: f.left.key }, {
    allowed: f.left.allowed, stopping: () => false, send: async () => '$sent',
  });
  assert.deepEqual(JSON.parse(await action({ action: 'list' }, new AbortController().signal)).rooms[0].agents, [a, b]);
});

test('an announcing message is learned before Grok admission and peer exchanges exhaust credit', async t => {
  const f = fixture(t); await f.left.allowed(room, owner);
  // Only the receiver of a paid mention needs to have announced itself to the sender.
  await f.right.discovery.pump(); await f.left.discovery.receive(room, f.right.outgoing.shift()!);
  f.left.links.credit(a); f.left.outgoing.length = 0;
  const queue = new WorkerQueue(join(f.dir, 'queue.sqlite'));
  const service = new WorkerService(queue, join(f.dir, 'files'), 100, { allowed: async () => true, receive: async () => undefined,
    prepare: async () => [], send: async () => {}, report: () => {} });
  t.after(() => { service.stop(); queue.close(); });
  const bridge = new WorkerBridge({ botId: b, links: f.right.links, authorized: s => s === owner, privateRoom: f.right.allowed,
    queue, service, state: f.right.state, reply: async () => {} });
  const first = message(a, '$first', f.left.links.outgoing(a, room, { msgtype: 'm.text', body: 'Review please' }, [b]));
  assert.ok(first.content?.[PEER_FIELD]);
  await f.right.discovery.receive(room, first as DiscoveryEvent);
  await bridge.handle(room, first); await bridge.handle(room, first);
  assert.equal(queue.list().length, 1); assert.equal(queue.list()[0].context?.session, 'grok-session');
  assert.deepEqual(new Set(queue.list()[0].context?.agents), new Set([a, b]));
  let from = f.right, to = f.left;
  for (let step = 0; from.links.peerCredit(from.bot) > 0; step++) {
    assert.ok(step < 10, 'two finite reserves must not sustain an endless exchange');
    const e = message(from.bot, '$chain' + step, from.links.outgoing(from.bot, room, { msgtype: 'm.text', body: 'Next' }, [to.bot]));
    assert.ok(e.content?.[GRANT]);
    await to.allowed(room, owner); to.links.observe(to.bot, room, e);
    assert.ok(to.links.mention(to.bot, room, e));
    [from, to] = [to, from];
  }
  assert.equal(from.links.peerCredit(from.bot), 0);
  assert.equal(from.links.reserveMentions(from.bot, room, [to.bot]), undefined);
});

test('leaving, rejoining and changed privacy invalidate discovered identities', async t => {
  const f = fixture(t); await f.introduce();
  const old = { type: PEER_EVENT, sender: b, event_id: '$old', origin_server_ts: f.now, content: f.right.links.announcement(b, room)! };
  f.leave(b); await f.left.allowed(room, owner); assert.deepEqual(f.left.links.bots(a, room), [a]);
  f.rejoin(b); await f.left.discovery.receive(room, old); assert.deepEqual(f.left.links.bots(a, room), [a]);
  await f.left.discovery.receive(room, { ...old, event_id: '$fresh', origin_server_ts: f.now });
  assert.deepEqual(f.left.links.bots(a, room), [a, b]);
  f.deny(); assert.equal(await f.left.allowed(room, owner), false); assert.deepEqual(f.left.links.bots(a, room), [a]);
});

test('discovery rejects wrong owners, absent senders, stale events and observer promotion', async t => {
  const f = fixture(t), base = { type: PEER_EVENT, sender: b, event_id: '$hello', origin_server_ts: f.now, content: f.right.links.announcement(b, room)! };
  for (const bad of [{ ...base, sender: '@outsider:test' }, { ...base, room_id: '!other:test' },
    { ...base, content: { ...base.content, owner: '@mallory:test' } }, { ...base, content: { ...base.content, version: 2 } },
    { ...base, type: 'm.room.message', content: { [PEER_FIELD]: base.content, 'm.relates_to': { rel_type: 'm.replace' } } },
    { ...base, origin_server_ts: f.now - 400_000 }, { ...base, content: { ...base.content, name: 'x'.repeat(101) } }]) {
    await f.left.discovery.receive(room, bad); assert.deepEqual(f.left.links.bots(a, room), [a]);
  }
  Object.assign(f.left.config.rooms[0], { observers: [b] }); writeFileSync(f.left.file, JSON.stringify(f.left.config)); f.left.restart();
  await f.left.discovery.receive(room, base); assert.deepEqual(f.left.links.bots(a, room), [a]);
  assert.equal(f.left.links.reserveMentions(a, room, [b]), undefined);
});

test('discovery responses are bounded and announcements stop with the service', async t => {
  const f = fixture(t); await f.right.discovery.pump(); const request = f.right.outgoing.shift()!;
  await f.left.discovery.receive(room, request); await f.left.discovery.receive(room, request);
  await f.left.discovery.receive(room, { ...request, event_id: '$other', content: { ...request.content, request: 'other' } });
  assert.equal(f.left.outgoing.length, 1);
  f.left.stop(); f.left.discovery.changed(room); await f.left.discovery.pump(); assert.equal(f.left.outgoing.length, 1);
});

for (const kind of ['m.room.message', PEER_EVENT]) for (const encrypted of [false, true]) for (const fail of [false, true]) test(`discovery runs only for decrypted input before durable inbox/checkpoint (kind=${kind}, encrypted=${encrypted}, failure=${fail})`, async t => {
  const f = fixture(t), storage = new SimpleFsStorageProvider(join(f.dir, 'matrix.json'));
  storage.setSyncToken('previous'); const order: string[] = [];
  class Client extends WorkerMatrixClient {
    run() { return this.startSyncInternal(); }
    protected override async doSync() { return { next_batch: 'next' }; }
    protected override async processSync(_raw: unknown, emit: any) {
      const e = { ...message(b, '$protocol-message', { msgtype: 'm.text', body: 'hello' }), type: kind };
      if (encrypted) await emit('room.decrypted_event', room, e);
      if (kind === 'm.room.message') await emit('room.message', room, e);
      await emit('room.event', room, e); this.stop();
    }
  }
  const client = new Client('https://matrix.test', 'synthetic-token', storage);
  let fatal = false; client.on('worker.inbox_failure', () => { fatal = true; });
  client.protocol = async () => { order.push('discovery'); if (fail) throw new Error('write failed'); };
  client.inbox = async () => { order.push('inbox'); assert.equal(storage.getSyncToken(), 'previous'); };
  await client.run(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, [...encrypted ? ['discovery'] : [],
    ...kind === 'm.room.message' && !(encrypted && fail) ? ['inbox'] : []]);
  assert.equal(fatal, encrypted && fail); assert.equal(storage.getSyncToken(), encrypted && fail ? 'previous' : 'next');
});


test('a cached peer cannot be mentioned after leaving and does not gain human access', async t => {
  const f = fixture(t); await f.introduce(); f.left.links.credit(a);
  let sent = false;
  const action = linkedRoomMessages(f.left.links, a, { room, event: message(owner, '$turn', {}), key: f.left.key }, {
    allowed: f.left.allowed, stopping: () => false, send: async () => { sent = true; return '$sent'; },
  });
  assert.equal(await f.left.allowed(room, b), false); // Discovery never grants human access.
  f.leave(b);
  await assert.rejects(action({ action: 'send', room, id: 'after-leave', text: 'Review please', mentions: [b] },
    new AbortController().signal), /Only other agents/);
  assert.equal(sent, false); assert.equal(f.left.links.peerCredit(a), 5);
});
