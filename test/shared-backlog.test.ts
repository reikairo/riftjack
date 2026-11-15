import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationLinks } from '../src/conversation-links.js';
import { SharedBacklog } from '../src/shared-backlog.js';
import { Bridge, NOTICE, SERVICE, sessionKey, type MatrixEvent } from '../src/bridge.js';
import { State } from '../src/state.js';

const bot = '@assistant:test', owner = '@alice:test', peer = '@reviewer:test';
const room = '!team:test', home = '!home:test';
const event = (body: string, id = '$message', sender = peer): MatrixEvent => ({ type: 'm.room.message',
  event_id: id, sender, origin_server_ts: Date.now(), content: { msgtype: 'm.text', body } });
const context = (prompt: string) => JSON.parse(prompt.split('\n')[1]);
function fixture(t: { after(fn: () => void): void }, kind: 'codex' | 'claude' | 'pi' = 'codex') {
  const dir = mkdtempSync(join(tmpdir(), 'shared-backlog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new State(join(dir, 'state.json'));
  const key = sessionKey(home, event('', '$anchor', owner));
  state.update(key, { [kind]: 'pinned' });
  const config = { version: 1, agents: [{ bot, owner, home, session: 'pinned' }],
    rooms: [{ room, owner, bots: [bot, peer] }] };
  const path = join(dir, 'links.json'), history = join(dir, 'history.json');
  writeFileSync(path, JSON.stringify(config));
  const load = () => new ConversationLinks(path, history, [{ userId: bot, kind, name: 'Assistant', accessToken: 'test' }], state, owner);
  const links = load();
  const add = (body: string, id = '$observation', sender = peer) => links.observe(bot, room, event(body, id, sender));
  const prompt = (e = event('Continue', '$turn', owner)) => links.prompt(bot, room, e, e.content!.body!);
  return { dir, state, key, config, path, history, load, links, add, prompt };
}

test('full batches use the prompt packing rules, without reading ahead or changing credit', t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) f.add('Short message', '$short' + i);
  assert.equal(f.links.backlog(bot), undefined);
  f.add('x'.repeat(9000), '$long');
  const next = f.links.backlog(bot)!;
  assert.ok(next); assert.equal(next.room, room); assert.equal(next.session, 'pinned');
  assert.equal(next.event.content![NOTICE], 'shared-backlog');
  assert.match(next.event.content!.body!, /primarily to deliver accumulated background messages/);
  assert.match(next.event.content!.body!, /Default to exactly NO_REPLY/);
  assert.match(next.event.content!.body!, /not a new human request or approval/);
  assert.equal(f.links.peerCredit(bot), 0);
  assert.equal(f.links.backlog(bot)!.event.event_id, next.event.event_id);
  const first = context(f.prompt(next.event));
  assert.equal(first.author, 'connector'); assert.equal(first.trigger, 'shared-backlog');
  assert.equal(first.unreadSharedMessages.at(-1).continues, true);
  assert.equal(f.load().backlog(bot)!.event.event_id, next.event.event_id);
  f.links.acknowledge(bot);
  assert.equal(f.links.backlog(bot), undefined);
  const tail = context(f.prompt()).unreadSharedMessages[0];
  assert.equal(tail.id, '$long');
  assert.equal(first.unreadSharedMessages.at(-1).body + tail.body, 'x'.repeat(9000));
});

test('threshold includes metadata and minimum space; own and service messages do not fill it', t => {
  const f = fixture(t);
  f.add('x'.repeat(20000), '$own', bot);
  f.links.observe(bot, room, { ...event('x'.repeat(20000), '$service'), content: { msgtype: 'm.text', body: 'x'.repeat(20000), [SERVICE]: 'confirmation' } });
  assert.equal(f.links.backlog(bot), undefined);
  f.add('x'.repeat(11088), '$almost'); // 512 characters remain after metadata.
  assert.equal(f.links.backlog(bot), undefined);
  f.add('next', '$next');
  assert.ok(f.links.backlog(bot));
});

test('admitted batches do not spin after failure or restart; unread text is still available', t => {
  const f = fixture(t); f.add('x'.repeat(30000));
  const next = f.links.backlog(bot)!;
  f.links.backlogAdmitted(bot, room, next.event.event_id!);
  assert.equal(f.links.backlog(bot), undefined);
  const restarted = f.load(); assert.equal(restarted.backlog(bot), undefined);
  const prompt = restarted.prompt(bot, room, event('Continue', '$normal', owner), 'Continue');
  assert.equal(context(prompt).unreadSharedMessages[0].offset, 0);
  restarted.acknowledge(bot);
  const following = restarted.backlog(bot)!;
  assert.ok(following); assert.notEqual(following.event.event_id, next.event.event_id);
  assert.equal(context(restarted.prompt(bot, room, following.event, following.event.content!.body!)).unreadSharedMessages[0].offset, 11600);
});

test('failed admission persistence leaves the full batch eligible', t => {
  const f = fixture(t); f.add('x'.repeat(12000));
  const next = f.links.backlog(bot)!;
  mkdirSync(f.history + '.tmp');
  assert.throws(() => f.links.backlogAdmitted(bot, room, next.event.event_id!));
  rmSync(f.history + '.tmp', { recursive: true });
  assert.equal(f.links.backlog(bot)!.event.event_id, next.event.event_id);
  assert.equal(f.load().backlog(bot)!.event.event_id, next.event.event_id);
});

test('a rebuilt room history cannot reuse the worker event identity for different messages', t => {
  const f = fixture(t); f.add('x'.repeat(12000), '$old');
  const previous = f.links.backlog(bot)!.event.event_id;
  rmSync(f.history);
  const links = f.load();
  links.observe(bot, room, event('x'.repeat(12000), '$new'));
  assert.notEqual(links.backlog(bot)!.event.event_id, previous);
});

for (const kind of ['codex', 'claude', 'pi'] as const) test(`${kind} receives full batches as silent observation turns in the pinned session`, async t => {
  const f = fixture(t, kind); f.add('x'.repeat(30000));
  const prompts: string[] = [], sent: string[] = [];
  let allowed = false, release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const bridge = new Bridge({ botId: bot, owner, kind, state: f.state, since: 0, timeoutMs: 10000,
    isAuthorized: sender => sender === owner, isPrivateRoom: async () => allowed,
    linkedSession: (r, e) => f.links.key(bot, r, e), shared: r => r === room,
    decoratePrompt: (r, e, p, steering) => f.links.prompt(bot, r, e, p, steering),
    promptDelivered: () => f.links.acknowledge(bot), accepted: () => f.links.credit(bot),
    run: async (_kind, p, key) => { assert.equal(key, f.key); prompts.push(p); await gate; return 'NO_REPLY'; },
    reply: async (_r, _e, text) => { sent.push(text); }, report: e => { throw e; },
  });
  const pump = new SharedBacklog(f.links, bot, { idle: () => !bridge.busy && !bridge.pendingTurns,
    deliver: (...args) => bridge.resumeBackground(...args) });
  await pump.pump(); assert.equal(prompts.length, 0); assert.ok(f.links.backlog(bot));
  allowed = true;
  const running = pump.pump();
  while (!prompts.length) await new Promise(r => setTimeout(r, 1));
  await pump.pump(); assert.equal(prompts.length, 1);
  release(); await running;
  await pump.pump(); assert.equal(prompts.length, 2);
  await pump.pump(); assert.equal(prompts.length, 2); // The smaller tail waits for a normal turn.
  assert.equal(context(prompts[1]).unreadSharedMessages[0].offset, 11600);
  assert.deepEqual(sent, []); assert.equal(f.links.peerCredit(bot), 0);
});

test('a normal turn consuming the batch during authorization wins over the automatic turn', async t => {
  const f = fixture(t); f.add('x'.repeat(12000));
  let deliveries = 0;
  const pump = new SharedBacklog(f.links, bot, { idle: () => true,
    deliver: async (_room, _event, _session, admitted, ready) => {
      f.prompt(); f.links.acknowledge(bot); // Concurrent ordinary prompt while access is being checked.
      if (!ready()) return false;
      admitted(); deliveries++; return true;
    } });
  await pump.pump(); assert.equal(deliveries, 0);
});

test('changed membership and pinned session cannot schedule old observations', t => {
  const f = fixture(t); f.add('x'.repeat(12000));
  f.config.rooms[0].bots.push('@new:test'); writeFileSync(f.path, JSON.stringify(f.config));
  assert.equal(f.load().backlog(bot), undefined);
  f.state.update(f.key, { codex: 'replacement' });
  assert.throws(() => f.links.backlog(bot), /session/);
});

test('an inaccessible full room does not starve another room, and their text stays separate', async t => {
  const f = fixture(t), other = '!other:test';
  f.config.rooms.push({ room: other, owner, bots: [bot, peer] });
  writeFileSync(f.path, JSON.stringify(f.config));
  const links = f.load();
  links.observe(bot, room, event('a'.repeat(12000), '$a'));
  links.observe(bot, other, event('b'.repeat(12000), '$b'));
  const deliveries: string[] = [];
  const pump = new SharedBacklog(links, bot, { idle: () => true,
    deliver: async (r, e, _session, admitted, ready) => {
      if (r === room) return false;
      assert.ok(ready()); admitted();
      const value = context(links.prompt(bot, r, e, e.content!.body!));
      assert.ok(value.unreadSharedMessages.every((m: { room: string }) => m.room === other));
      deliveries.push(r); links.acknowledge(bot); return true;
    } });
  await pump.pump(); assert.deepEqual(deliveries, [other]);
  assert.equal(links.backlog(bot)!.room, room);
});

test('a failed local automatic turn is attempted once and retains unread observations', async t => {
  const f = fixture(t); f.add('x'.repeat(12000));
  let runs = 0;
  const errors: unknown[] = [];
  const bridge = new Bridge({ botId: bot, owner, kind: 'codex', state: f.state, since: 0, timeoutMs: 10000,
    isAuthorized: () => true, isPrivateRoom: async () => true,
    linkedSession: (r, e) => f.links.key(bot, r, e), shared: r => r === room,
    decoratePrompt: (r, e, p) => f.links.prompt(bot, r, e, p), promptDelivered: () => f.links.acknowledge(bot),
    run: async () => { runs++; throw new Error('backend unavailable'); }, reply: async () => {}, report: e => { errors.push(e); },
  });
  const pump = new SharedBacklog(f.links, bot, { idle: () => !bridge.busy && !bridge.pendingTurns,
    deliver: (...args) => bridge.resumeBackground(...args) });
  await pump.pump(); await pump.pump();
  assert.equal(runs, 1); assert.equal(errors.length, 1);
  assert.equal(f.load().backlog(bot), undefined);
  assert.equal(context(f.prompt()).unreadSharedMessages[0].offset, 0);
});
