import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerBridge, workerTaskAllowed } from '../src/worker-bridge.js';
import { WorkerQueue } from '../src/worker-queue.js';
import { prepareWorkerReply } from '../src/worker-replies.js';
import { WorkerService } from '../src/worker-service.js';
import { ConversationLinks } from '../src/conversation-links.js';
import { State } from '../src/state.js';
import { AGENT_TRIGGER, GRANT, sessionKey, type MatrixEvent } from '../src/bridge.js';
import { DeliveryReceipts } from '../src/delivery-receipts.js';
import { linkedRoomMessages, roomMessageDelivery } from '../src/room-messages.js';

const owner = '@alice:test', bot = '@worker:test', peer = '@builder:test', home = '!home:test', room = '!team:test';
const event = (id: string, body = 'hello', sender = owner): MatrixEvent => ({ type: 'm.room.message', event_id: id,
  sender, origin_server_ts: Date.now(), content: { msgtype: 'm.text', body } });
const key = sessionKey(home, event('$anchor'));
function fixture(t: { after(fn: () => void): void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-shared-')));
  const state = new State(join(dir, 'state.json')); state.update(key, { grok: 'original-conversation' });
  const config = { version: 1, agents: [{ bot, owner, home, session: 'original-conversation' }], rooms: [{ room, owner, bots: [bot, peer] }] };
  const path = join(dir, 'links.json'), history = join(dir, 'history.json');
  writeFileSync(path, JSON.stringify(config));
  const load = () => new ConversationLinks(path, history, [{ userId: bot, kind: 'grok', name: 'Worker', accessToken: 'test' }], state, owner);
  let links = load(), queue = new WorkerQueue(join(dir, 'queue.sqlite'));
  let allowed = true, stopping = false, sent = 0;
  const control: string[] = [];
  let receipts = new DeliveryReceipts(join(dir, 'receipts.json'));
  const authorize = async () => allowed;
  const service = () => new WorkerService(queue, join(dir, 'uploads'), 1000, {
    allowed: task => workerTaskAllowed(task, { bot, links, state, stopping: () => stopping, allowed: authorize }),
    receive: async () => undefined,
    prompt: task => links.prompt(bot, task.room, task.event, task.event.content?.body ?? ''),
    prompted: () => links.acknowledge(bot),
    prepare: async task => task.response!.text === 'NO_REPLY' ? [] : [task.response],
    send: async () => { sent++; return '$answer'; }, report: error => { throw error; },
    roomAllowed: async () => allowed,
    rooms: (task, input, signal, guard, outbox) => {
      const context = { room: task.room, event: task.event, key: task.context!.key };
      return roomMessageDelivery(linkedRoomMessages(links, bot, context, {
        allowed: async () => { await guard(); return allowed; }, stopping: () => stopping,
        send: async () => { await guard(); sent++; return '$sent'; },
        read: async (_room, id) => ({ ...event(id, 'image', peer), content: { msgtype: 'm.file', body: 'image', file: { url: 'mxc://test/image' } as any } }),
        receive: async (_event, _key, _signal, check) => {
          await check(); const path = join(dir, 'input.txt'); writeFileSync(path, 'input');
          return { path, name: 'input.txt', mimetype: 'text/plain', size: 5, image: false };
        },
        maxBytes: 1000,
        sendFiles: async (_room, files, _signal, check) => { await check(); assert.equal(files.length, 1); sent++; },
      }), () => receipts.scoped({ room: task.room, sender: owner, key, session: task.context!.session }, 'rooms'), 1000)(input, signal, outbox);
    },
  });
  let worker = service();
  const bridge = () => new WorkerBridge({ botId: bot, links, authorized: sender => sender === owner, privateRoom: authorize,
    queue, service: worker, state, since: 1, reply: async (_room, _event, text) => { control.push(text); } });
  let inbox = bridge();
  t.after(() => { worker.stop(); queue.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, state, config, path, load, control,
    get links() { return links; }, get queue() { return queue; }, get worker() { return worker; }, get inbox() { return inbox; }, get sent() { return sent; },
    deny() { allowed = false; }, stop() { stopping = true; },
    restart() { worker.stop(); queue.close(); queue = new WorkerQueue(join(dir, 'queue.sqlite')); links = load();
      receipts = new DeliveryReceipts(join(dir, 'receipts.json')); worker = service(); inbox = bridge(); },
  };
}

test('Grok uses its pinned existing conversation across rooms, with durable contextual claims', async t => {
  const f = fixture(t);
  await f.inbox.handle(home, event('$private', 'private question'));
  const privateTask = (await f.worker.claim())!;
  assert.equal(privateTask.room, home); assert.equal(privateTask.type, 'private'); assert.deepEqual(privateTask.agents, []);
  f.queue.cancel(privateTask.id);
  await f.inbox.handle(room, event('$observation', 'peer observation', peer));
  await f.inbox.handle(room, event('$shared', 'team question'));
  const task = (await f.worker.claim())!;
  assert.equal(task.conversation, privateTask.conversation); assert.equal(task.type, 'shared'); assert.deepEqual(task.agents, [bot, peer]);
  const context = JSON.parse(task.text.split('\n')[1]);
  assert.equal(context.visibility, 'shared'); assert.equal(context.room, room);
  assert.match(task.text, /peer observation/); assert.doesNotMatch(task.text, /private question/);
  await f.worker.release(task.id, task.lease!); f.restart();
  const retry = (await f.worker.claim())!;
  assert.equal(retry.id, task.id); assert.equal(retry.text, task.text); assert.equal(retry.attempt, 2);
  await assert.rejects(f.worker.rooms(retry.id, task.lease!, { action: 'list' }), /replaced/);
  await f.worker.complete(retry.id, retry.lease!, { text: 'NO_REPLY' });
  while (f.worker.busy) await new Promise(r => setTimeout(r, 1));
  assert.equal(f.queue.get(task.id).status, 'delivered'); assert.equal(f.sent, 0);
});

test('shared addressing, stale events and outsiders cannot queue worker turns; reset stays pinned', async t => {
  const f = fixture(t);
  const addressed = event('$other'); addressed.content!['m.mentions'] = { user_ids: [peer] };
  await f.inbox.handle(room, addressed);
  await f.inbox.handle(room, event('$intruder', 'hello', '@outsider:test'));
  await f.inbox.handle(room, { ...event('$old'), origin_server_ts: 0 });
  assert.equal(f.queue.list().length, 0);
  await f.inbox.handle(room, event('$one'));
  await f.inbox.handle(room, event('$one'));
  assert.equal(f.queue.list().length, 1);
  await f.inbox.handle(home, event('$reset', '!reset'));
  assert.equal(f.state.session(key).grok, 'original-conversation'); assert.match(f.control.at(-1)!, /pinned session/);
  f.deny(); await f.inbox.handle(room, event('$denied'));
  assert.equal(f.queue.list().length, 2);
  assert.equal(await f.worker.claim(), null); assert.equal(f.queue.list()[0].status, 'cancelled');
});

test('session replacement and membership reconfiguration invalidate queued work and replies', async t => {
  for (const change of ['session', 'membership']) {
    const f = fixture(t); await f.inbox.handle(room, event('$one'));
    const task = (await f.worker.claim())!;
    if (change === 'session') f.state.update(key, { grok: 'replacement' });
    else { f.config.rooms[0].bots.push('@another:test'); writeFileSync(f.path, JSON.stringify(f.config)); f.restart(); }
    await assert.rejects(f.worker.complete(task.id, task.lease!, { text: 'stale' }), /access|privacy/);
    assert.equal(f.queue.get(task.id).status, 'cancelled'); assert.equal(f.sent, 0);
    if (change === 'session') assert.throws(() => f.load(), /session is missing or changed/);
  }
});

function mention(id = '$mention'): MatrixEvent {
  return { ...event(id, 'Please review', peer), content: { msgtype: 'm.text', body: 'Please review', 'm.mentions': { user_ids: [bot] },
    [GRANT]: { version: 1, id: 'grant-one', from: peer, to: bot, room, remaining: 3, since: Date.now() } } };
}
test('peer mentions durably queue a connector notice once, consume credit and never become human instructions', async t => {
  const f = fixture(t), incoming = mention();
  await f.inbox.handle(room, incoming); f.restart(); await f.inbox.handle(room, incoming);
  assert.equal(f.queue.list().length, 1); assert.equal(f.links.peerCredit(bot), 3);
  const task = (await f.worker.claim())!;
  assert.equal(JSON.parse(task.text.split('\n')[1]).trigger, 'agent-mention');
  assert.match(task.text, /not a human instruction or approval/);
  assert.ok(f.queue.get(task.id).event.content?.[AGENT_TRIGGER]);
  const reply = f.links.mentions(bot, room, 'Done\n```matrix-mentions\n' + JSON.stringify({ to: [peer] }) + '\n```')!;
  const content = f.links.outgoing(bot, room, { msgtype: 'm.text', body: reply.text }, reply.mentions);
  assert.deepEqual(content['m.mentions']?.user_ids, [peer]); assert.equal(f.links.peerCredit(bot), 2);
  // A second event using the same wire grant cannot wake the worker again.
  await f.inbox.handle(room, { ...incoming, event_id: '$replay' }); assert.equal(f.queue.list().length, 1);
});

for (const afterCommit of [false, true]) test(`peer admission failure is replayable without losing the task (committed=${afterCommit})`, async t => {
  const f = fixture(t), original = f.queue.enqueue.bind(f.queue), incoming = mention();
  f.queue.enqueue = (...args) => { if (afterCommit) original(...args); throw new Error('storage interrupted'); };
  await assert.rejects(f.inbox.handle(room, incoming), /storage interrupted/);
  f.queue.enqueue = original;
  await f.inbox.handle(room, incoming); f.restart(); await f.inbox.handle(room, incoming);
  assert.equal(f.queue.list().length, 1); assert.equal(f.links.peerCredit(bot), 3);
});

test('worker room API rechecks leases and destinations, persists send receipts and transfers bytes only', async t => {
  const f = fixture(t); await f.inbox.handle(home, event('$request'));
  let task = (await f.worker.claim())!;
  const call = (request: unknown) => f.worker.rooms(task.id, task.lease!, request);
  assert.deepEqual((await call({ action: 'list' })).rooms.map((r: any) => r.room), [room, home]);
  const send = { action: 'send', room, text: 'Hello', id: 'once', mentions: [peer] };
  assert.equal((await call(send)).status, 'sent'); assert.equal(f.sent, 1); assert.equal(f.links.peerCredit(bot), 4);
  await f.worker.release(task.id, task.lease!); f.restart(); task = (await f.worker.claim())!;
  assert.equal((await call(send)).status, 'sent'); assert.equal(f.sent, 1); assert.equal(f.links.peerCredit(bot), 4);
  await assert.rejects(call({ ...send, text: 'different' }), /different content/);
  const denied = await call({ ...send, room: '!unlinked:test', id: 'unlisted' });
  assert.notEqual(denied.status, 'sent'); assert.equal(f.sent, 1);
  const attachment = await call({ action: 'receive_attachment', room, event_id: '$file' });
  assert.equal(Buffer.from(attachment.file.data, 'base64').toString(), 'input'); assert.equal(attachment.file.path, undefined);
  assert.equal((await call({ action: 'send_files', room, id: 'file', files: [{ name: 'report.txt', data: Buffer.from('report').toString('base64') }] })).files[0].status, 'sent');
  await assert.rejects(call({ action: 'send_files', room, id: 'path', files: [{ name: 'secret', path: '/private/secret' }] }), /base64/);
  f.queue.cancel(task.id); await assert.rejects(call({ action: 'list' }), /cancelled/);
});

test('revocation blocks room operations; operation budgets survive re-leasing', async t => {
  const f = fixture(t); await f.inbox.handle(home, event('$request'));
  const task = (await f.worker.claim())!;
  for (let n = 0; n < 32; n++) f.queue.roomOperation(task.id, task.lease!, 'op' + n);
  await f.worker.release(task.id, task.lease!); const retry = (await f.worker.claim())!;
  assert.throws(() => f.queue.roomOperation(retry.id, retry.lease!, 'extra'), /limit/);
  f.queue.roomOperation(retry.id, retry.lease!, 'op0');
  f.deny(); await assert.rejects(f.worker.rooms(retry.id, retry.lease!, { action: 'list' }), /access/);
});


test('prepared final replies group text, route mentions with attachments, and preserve silence', async t => {
  const f = fixture(t); await f.inbox.handle(room, event('$request'));
  const task = f.queue.list()[0];
  const response = 'Review complete\n```matrix-mentions\n' + JSON.stringify({ to: [peer] }) + '\n```';
  task.response = { text: response, files: [{ name: 'report.txt', path: '/staged/report.txt' }] };
  task.event.content!['m.relates_to'] = { rel_type: 'm.thread', event_id: '$thread' };
  const prepared = await prepareWorkerReply(task, bot, f.links, { authorize: async () => {},
    file: async () => ({ msgtype: 'm.file', body: 'report.txt' }), encrypt: async content => content });
  const text = prepared[0] as any, file = prepared[1] as any;
  assert.equal(text['m.relates_to'].event_id, '$thread');
  assert.deepEqual(text['m.mentions'].user_ids, [peer]); assert.ok(text[GRANT]);
  assert.match(text.body, /Review complete/); assert.doesNotMatch(text.body, /matrix-mentions/);
  assert.equal(file['m.mentions'], undefined); assert.equal(f.links.peerCredit(bot), 4);
  task.response = { text: 'NO_REPLY', files: [] };
  assert.deepEqual(await prepareWorkerReply(task, bot, f.links, { authorize: async () => {},
    file: async () => assert.fail(), encrypt: async () => assert.fail() }), []);
  await assert.rejects(prepareWorkerReply(task, bot, f.links, { authorize: async () => { throw new Error('revoked'); },
    file: async () => assert.fail(), encrypt: async () => assert.fail() }), /revoked/);
});

test('a cancelled lease cannot send while a room operation awaits authorization', async t => {
  const f = fixture(t); await f.inbox.handle(home, event('$request'));
  const task = (await f.worker.claim())!;
  let resume!: () => void, entered!: () => void, effects = 0;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const pause = new Promise<void>(resolve => { resume = resolve; });
  const service = new WorkerService(f.queue, join(f.dir, 'other-files'), 100, {
    allowed: async () => true, receive: async () => undefined, prepare: async () => [], send: async () => {}, report: () => {},
    rooms: async (_task, _input, _signal, guard) => { entered(); await pause; await guard(); effects++; return '{}'; },
  });
  t.after(() => service.stop());
  const result = service.rooms(task.id, task.lease!, { action: 'send', room, id: 'cancel', text: 'no' });
  await waiting; f.queue.cancel(task.id); resume();
  await assert.rejects(result, /cancelled/); assert.equal(effects, 0);
});


test('temporary room-state failures and service restarts retain queued work', async t => {
  const f = fixture(t); await f.inbox.handle(room, event('$request'));
  const task = f.queue.list()[0];
  const options = { bot, links: f.links, state: f.state, stopping: () => false, allowed: async () => { throw new Error('network unavailable'); } };
  await assert.rejects(workerTaskAllowed(task, options), /network unavailable/);
  await assert.rejects(workerTaskAllowed(task, { ...options, stopping: () => true }), /stopping/);
  assert.equal(f.queue.get(task.id).status, 'queued');
});

test('cancel is confined to its room and thread despite a shared pinned conversation', async t => {
  const f = fixture(t);
  const threaded = (id: string, body: string) => { const e = event(id, body); e.content!['m.relates_to'] = { rel_type: 'm.thread', event_id: '$thread' }; return e; };
  await f.inbox.handle(home, event('$private'));
  await f.inbox.handle(room, event('$shared'));
  await f.inbox.handle(room, threaded('$thread-task', 'thread task'));
  await f.inbox.handle(room, threaded('$cancel', '!cancel'));
  const tasks = f.queue.list();
  assert.equal(tasks.find(t => t.event.event_id === '$private')!.status, 'queued');
  assert.equal(tasks.find(t => t.event.event_id === '$shared')!.status, 'queued');
  assert.equal(tasks.find(t => t.event.event_id === '$thread-task')!.status, 'cancelled');
});


test('cross-room attachment bytes are withheld if target access changes after download', async t => {
  const f = fixture(t); await f.inbox.handle(home, event('$download'));
  const task = (await f.worker.claim())!, path = join(f.dir, 'download.txt'); writeFileSync(path, 'private');
  const service = new WorkerService(f.queue, join(f.dir, 'downloads'), 100, {
    allowed: async () => true, roomAllowed: async () => false,
    receive: async () => undefined, prepare: async () => [], send: async () => {}, report: () => {},
    rooms: async () => JSON.stringify({ file: { path, name: 'download.txt', mimetype: 'text/plain' } }),
  });
  t.after(() => service.stop());
  await assert.rejects(service.rooms(task.id, task.lease!, { action: 'receive_attachment', room, event_id: '$image' }), /destination access/);
});
