import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerQueue } from '../src/worker-queue.js';
import { WorkerService } from '../src/worker-service.js';
import { WorkerBridge, workerInitiative, workerTaskAllowed } from '../src/worker-bridge.js';
import { State } from '../src/state.js';
import { NOTICE, sessionKey, type MatrixEvent } from '../src/bridge.js';
import { prepareWorkerReply } from '../src/worker-replies.js';
import { loadConfig } from '../src/config.js';

const bot = '@worker:test', owner = '@alice:test', home = '!home:test';
const event = (id: string, body = 'hello'): MatrixEvent => ({ type: 'm.room.message',
  event_id: id, sender: owner, content: { msgtype: 'm.text', body } });
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-initiative-'));
  let now = 1000, enabled = true, access = true;
  let state = new State(join(dir, 'state.json')), queue = new WorkerQueue(join(dir, 'queue.sqlite'), () => now, 100);
  const make = () => new WorkerService(queue, join(dir, 'files'), 100, {
    initiative: enabled ? { intervalMs: 60_000, prepare: (s, text, id) => workerInitiative(s, text, id, bot) } : undefined,
    allowed: task => workerTaskAllowed(task, { bot, state, stopping: () => false, allowed: async () => access }),
    receive: async () => undefined, prepare: async () => [], send: async () => {}, report: () => {},
  });
  let service = make();
  const inbox = () => new WorkerBridge({ botId: bot, queue, service, state, authorized: x => x === owner,
    privateRoom: async () => access, reply: async () => {} });
  t.after(() => { service.stop(); queue.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get queue() { return queue; }, get service() { return service; }, get state() { return state; }, inbox,
    advance() { now += 60_001; }, deny() { access = false; },
    restart(allow = true) { service.stop(); queue.close(); enabled = allow;
      state = new State(join(dir, 'state.json')); queue = new WorkerQueue(join(dir, 'queue.sqlite'), () => now, 100); service = make(); } };
}

test('worker restart notices target an existing session, survive restart and deduplicate', async t => {
  const f = fixture(t);
  await f.inbox().handle(home, event('$human'));
  const source = (await f.service.claim())!; f.queue.cancel(source.id);
  const session = f.state.session(sessionKey(home, event('$human'))).grok!;
  await f.inbox().scheduleRestart('boot', home, owner, session, undefined, 'Revision and release notes');
  await f.inbox().scheduleRestart('boot', home, owner, session, undefined, 'Revision and release notes');
  f.restart();
  const notice = (await f.service.claim())!;
  assert.equal(f.queue.get(notice.id).event.content?.[NOTICE], 'restart');
  assert.match(notice.text, /not a human message or approval/);
  assert.match(notice.text, /Revision and release notes/);
  assert.equal(notice.conversation, source.conversation);
  const task = f.queue.get(notice.id); task.response = { text: 'NO_REPLY', files: [] };
  assert.deepEqual(await prepareWorkerReply(task, bot, undefined, {
    authorize: async () => {}, file: async () => ({}), encrypt: async content => content,
  }), []);
  f.queue.cancel(notice.id); assert.equal(await f.service.claim(), null);
});

test('worker restart does not create sessions or bypass access, reset and stop', async t => {
  for (const deny of ['missing', 'access', 'reset', 'stop']) {
    const f = fixture(t), bridge = f.inbox();
    const key = sessionKey(home, event('$human'));
    if (deny !== 'missing') f.state.update(key, { grok: 'session' });
    if (deny === 'access') f.deny();
    if (deny === 'reset') f.state.update(key, { grok: 'replacement' });
    if (deny === 'stop') bridge.stop();
    await bridge.scheduleRestart('boot', home, owner, 'session', undefined, 'Update');
    assert.equal(f.queue.list().length, 0);
  }
});

test('initiative persists without a lease, deduplicates across restart and respects cooldown and cancellation', async t => {
  const f = fixture(t);
  await f.inbox().handle(home, event('$human'));
  const source = (await f.service.claim())!;
  f.queue.cancel(source.id);
  const request = { id: 'report-1', text: 'Report the completed work.' };
  const receipt = await f.service.initiate(source.id, request);
  assert.equal(receipt.conversation, source.conversation);
  const queued = f.queue.get(receipt.id);
  assert.equal(queued.event.content?.[NOTICE], 'background');
  assert.match(queued.event.content!.body!, /not a new human message/);
  f.restart();
  assert.equal((await f.service.initiate(source.id, request)).id, receipt.id);
  await assert.rejects(f.service.initiate(source.id, { ...request, text: 'different' }), /different content/);
  await assert.rejects(f.service.initiate(source.id, { ...request, id: 'report-2' }), { status: 429 });
  f.advance();
  await assert.rejects(f.service.initiate(source.id, { ...request, id: 'report-2' }), /already pending/);
  const task = (await f.service.claim())!;
  assert.equal(task.id, receipt.id);
  await f.inbox().handle(home, event('$cancel', '!cancel'));
  assert.equal((await f.service.initiate(source.id, request)).status, 'cancelled');
  await assert.rejects(f.service.complete(task.id, task.lease!, { text: 'late answer' }), { status: 409 });
  const next = await f.service.initiate(source.id, { ...request, id: 'report-2' });
  assert.notEqual(next.id, receipt.id);
});

test('owner opt-out, revoked access and reset prevent new or outstanding initiatives', async t => {
  for (const change of ['disable', 'access', 'reset'] as const) {
    const f = fixture(t);
    await f.inbox().handle(home, event('$human'));
    const source = (await f.service.claim())!; f.queue.cancel(source.id);
    const receipt = await f.service.initiate(source.id, { id: 'report', text: 'Update' });
    if (change === 'disable') f.restart(false);
    if (change === 'access') f.deny();
    if (change === 'reset') f.state.update(sessionKey(home, event('$human')), { grok: 'replacement' });
    await assert.rejects(f.service.initiate(source.id, { id: 'next', text: 'Update' }), { status: 403 });
    assert.equal(await f.service.claim(), null);
    assert.equal(f.queue.get(receipt.id).status, 'cancelled');
  }
});

test('initiative does not accept routing overrides or an arbitrary conversation', async t => {
  const f = fixture(t);
  await f.inbox().handle(home, event('$human')); const source = (await f.service.claim())!;
  for (const extra of [{ room: '!other:test' }, { conversation: 'other' }, { sender: '@other:test' }, { lease: 'invented' }]) {
    await assert.rejects(f.service.initiate(source.id, { id: 'next', text: 'note', ...extra }), { status: 400 });
  }
  await assert.rejects(f.service.initiate(source.id, { id: '../bad', text: 'note' }), { status: 400 });
  await assert.rejects(f.service.initiate(source.id, { id: 'ok', text: 'x'.repeat(16001) }), { status: 400 });
  await assert.rejects(f.service.initiate('unknown', { id: 'ok', text: 'note' }), { status: 404 });
});

test('initiative respects home threads and can finish quietly without a linked room', async t => {
  const f = fixture(t), message = event('$threaded');
  message.content!['m.relates_to'] = { rel_type: 'm.thread', event_id: '$root' };
  await f.inbox().handle(home, message); const source = (await f.service.claim())!;
  f.queue.cancel(source.id);
  const receipt = await f.service.initiate(source.id, { id: 'report', text: 'note' });
  const task = f.queue.get(receipt.id);
  assert.deepEqual(task.event.content!['m.relates_to'], message.content!['m.relates_to']);
  task.response = { text: 'NO_REPLY', files: [] };
  assert.deepEqual(await prepareWorkerReply(task, bot, undefined, {
    authorize: async () => {}, encrypt: async x => x, file: async () => ({}) }), []);
});

test('initiative configuration requires owner opt-in and an integer cooldown', () => {
  const env = { MATRIX_HOMESERVER: 'https://example.org', MATRIX_OWNER_ID: owner, RIFTJACK_WORKSPACE: process.cwd() };
  assert.equal(loadConfig(env).workerInitiativeIntervalMs, 0);
  assert.equal(loadConfig({ ...env, WORKER_INITIATIVE_INTERVAL_SECONDS: '300' }).workerInitiativeIntervalMs, 300_000);
  for (const value of ['-1', '1', '59', '60.5', '86401', 'NaN']) {
    assert.throws(() => loadConfig({ ...env, WORKER_INITIATIVE_INTERVAL_SECONDS: value }), /WORKER_INITIATIVE_INTERVAL_SECONDS/);
  }
});
