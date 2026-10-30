import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryReceipts } from '../src/delivery-receipts.js';
import { attachmentDelivery } from '../src/attachment-delivery.js';
import { Bridge, type BackendHooks, type MatrixEvent } from '../src/bridge.js';
import { State } from '../src/state.js';
import { roomMessageDelivery } from '../src/room-messages.js';
const target = { room: '!home:test', sender: '@alice:test', key: 'key', session: 'session', thread: '$thread' };
function fixture(t: { after(fn: () => void): void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'delivery-receipts-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'receipts.json');
  return { dir, path, store: new DeliveryReceipts(path) };
}
const signal = () => new AbortController().signal;

test('message receipts deduplicate across turns and restart, with exact content and destination', async t => {
  const f = fixture(t); let sent = 0;
  const send = async () => { sent++; return JSON.stringify({ status: 'sent', event_id: '$sent' }); };
  const input = { action: 'send', room: '!shared:test', id: 'message-1', text: 'Hello' };
  const first = roomMessageDelivery(send, () => f.store.scoped(target, 'rooms'));
  const result = await first(input, signal());
  const restart = new DeliveryReceipts(f.path);
  const next = roomMessageDelivery(send, () => restart.scoped(target, 'rooms'));
  assert.equal(await next(input, signal()), result); assert.equal(sent, 1);
  await assert.rejects(next({ ...input, text: 'Changed' }, signal()), /different content/);
  await assert.rejects(next({ ...input, room: '!other:test' }, signal()), /different content/);
  const receipt = JSON.parse(await next({ action: 'status', id: input.id }, signal()));
  assert.equal(receipt.result.event_id, '$sent'); assert.equal(receipt.status, 'sent');
});

test('lost response and connector crash retain uncertainty without replaying a send', async t => {
  const f = fixture(t); let sent = 0;
  const run = f.store.scoped(target, 'rooms');
  const result = await run.run('uncertain-1', 'body', async () => { sent++; throw new Error('Response lost'); });
  assert.equal(JSON.parse(result).status, 'uncertain');
  const restarted = new DeliveryReceipts(f.path).scoped(target, 'rooms');
  assert.equal(await restarted.run('uncertain-1', 'body', async () => { assert.fail('No replay'); }), result);
  let release!: () => void;
  const wait = new Promise<void>(r => { release = r; });
  const pending = run.run('pending-1', 'body', async () => { sent++; await wait; return '{"status":"sent"}'; });
  const afterCrash = new DeliveryReceipts(f.path).scoped(target, 'rooms');
  const recovered = await afterCrash.run('pending-1', 'body', async () => assert.fail('No replay'));
  assert.equal(JSON.parse(recovered).status, 'uncertain');
  release(); await pending; assert.equal(sent, 2);
});

test('receipts are isolated by room, sender, thread, conversation, session and tool', async t => {
  const f = fixture(t);
  await f.store.scoped(target, 'rooms').run('id', 'body', async () => '{"status":"sent"}');
  for (const key of ['room', 'sender', 'thread', 'key', 'session']) {
    assert.throws(() => f.store.scoped({ ...target, [key]: 'other' }, 'rooms').read('id'), /not found/);
  }
  assert.throws(() => f.store.scoped(target, 'attachments').read('id'), /not found/);
});

test('storage failure before admission prevents the external send', async t => {
  const f = fixture(t); mkdirSync(f.path + '.tmp');
  assert.throws(() => f.store.scoped(target, 'rooms').run('id', 'body', async () => assert.fail('No send')));
  assert.deepEqual(JSON.parse(f.store.scoped(target, 'rooms').read()), []);
});

test('attachment receipts survive outbox replacement and reject changed bytes under the same id', async t => {
  const f = fixture(t); let sent = 0;
  const file = join(f.dir, 'picture.txt'); writeFileSync(file, 'picture');
  const input = { id: 'picture-1', files: [{ path: 'picture.txt' }] };
  const first = attachmentDelivery(f.dir, 1024, async () => { sent++; }, () => f.store.scoped(target, 'attachments'));
  const result = await first.action(input, signal()); assert.equal(JSON.parse(result).files[0].status, 'sent');
  rmSync(file);
  const next = attachmentDelivery(f.dir, 1024, async () => { sent++; }, () => new DeliveryReceipts(f.path).scoped(target, 'attachments'));
  assert.equal(JSON.parse(await next.action({ action: 'status', id: input.id }, signal())).status, 'sent');
  writeFileSync(file, 'picture');
  assert.equal(await next.action(input, signal()), result); assert.equal(sent, 1);
  assert.deepEqual(next.final({ text: 'Done', attachments: [{ root: f.dir, path: file }] }), { text: 'Done', attachments: [] });
  writeFileSync(file, 'different');
  const third = attachmentDelivery(f.dir, 1024, async () => assert.fail('No send'), () => new DeliveryReceipts(f.path).scoped(target, 'attachments'));
  await assert.rejects(third.action(input, signal()), /different content/);
  await assert.rejects(next.action({ ...input, id: 'new-id' }, signal()), /changed during this turn/);
  assert.equal(sent, 1);
});

test('partial file delivery retains individual receipts and never sends the batch twice', async t => {
  const f = fixture(t); let sent = 0;
  for (const name of ['a', 'b', 'c']) writeFileSync(join(f.dir, name), name);
  const input = { id: 'batch', files: ['a', 'b', 'c'].map(path => ({ path })) };
  const first = attachmentDelivery(f.dir, 1024, async () => { if (++sent === 2) throw new Error('Response lost'); }, () => f.store.scoped(target, 'attachments'));
  const result = await first.action(input, signal());
  assert.deepEqual(JSON.parse(result).files.map((f: {status: string}) => f.status), ['sent', 'uncertain', 'not_sent']);
  const next = attachmentDelivery(f.dir, 1024, async () => assert.fail('No replay'), () => new DeliveryReceipts(f.path).scoped(target, 'attachments'));
  assert.equal(await next.action(input, signal()), result); assert.equal(sent, 2);
});

test('linked-room file receipts bind byte content rather than the transient outbox path', async t => {
  const f = fixture(t); let sent = 0;
  const input = { action: 'send_files', room: '!shared:test', id: 'files', files: [{ path: 'a' }] };
  const firstDir = join(f.dir, 'first'), secondDir = join(f.dir, 'second'); mkdirSync(firstDir); mkdirSync(secondDir);
  writeFileSync(join(firstDir, 'a'), 'same'); writeFileSync(join(secondDir, 'a'), 'same');
  const tool = () => roomMessageDelivery(async () => { sent++; return '{"files":[{"path":"a","status":"sent"}]}'; }, () => f.store.scoped(target, 'rooms'));
  const result = await tool()(input, signal(), firstDir);
  assert.equal(await tool()(input, signal(), secondDir), result); assert.equal(sent, 1);
  writeFileSync(join(secondDir, 'a'), 'changed');
  await assert.rejects(tool()(input, signal(), secondDir), /different content/);
});


const event = (id: string): MatrixEvent => ({ type: 'm.room.message', sender: target.sender, event_id: id,
  origin_server_ts: Date.now(), content: { body: 'Deliver', msgtype: 'm.text',
    'm.relates_to': { rel_type: 'm.thread', event_id: target.thread } } });

for (const outcome of ['sent', 'uncertain'] as const) test(`final-manifest ${outcome} receipt prevents redelivery after recovery of the same source event`, async t => {
  const f = fixture(t); let sends = 0;
  const file = join(f.dir, 'result.txt'); writeFileSync(file, 'result');
  for (let attempt = 0; attempt < 2; attempt++) {
    // The input journal may still contain the event if completion was not saved.
    const state = new State(join(f.dir, `state-${attempt}.json`)); state.update(target.key, { codex: target.session });
    const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 10000, state,
      receipts: new DeliveryReceipts(f.path), isAuthorized: () => true, isPrivateRoom: async () => true,
      linkedSession: () => target.key, reply: async () => {}, report: () => {},
      run: async () => ({ text: 'Ready', attachments: [{ root: f.dir, path: file }] }),
      sendAttachments: async () => { sends++; if (outcome === 'uncertain') throw new Error('Response lost'); },
    });
    await bridge.handle(target.room, event('$original'));
    bridge.stop();
  }
  assert.equal(sends, 1);
  const records = JSON.parse(new DeliveryReceipts(f.path).scoped(target, 'attachments').read());
  assert.equal(records.length, 1); assert.equal(records[0].status, outcome);
});

test('bridge receipt lookup rechecks access and rejects hooks from a completed turn', async t => {
  const f = fixture(t), state = new State(join(f.dir, 'state.json')); state.update(target.key, { codex: target.session });
  let allowed = true, hooks!: BackendHooks;
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 10000, state,
    receipts: f.store, isAuthorized: () => allowed, isPrivateRoom: async () => true,
    linkedSession: () => target.key, reply: async () => {}, report: () => {},
    run: async (_mode, _prompt, _key, _signal, _sender, _files, _interact, _publish, activeHooks) => {
      hooks = activeHooks!;
      assert.deepEqual(JSON.parse((await hooks.deliveryReceipts!()).read()), []);
      allowed = false;
      await assert.rejects(hooks.deliveryReceipts!(), /access|revoked/i);
      allowed = true;
      return 'Done';
    },
  });
  await bridge.handle(target.room, event('$lookup'));
  await assert.rejects(hooks.deliveryReceipts!(), /abort/i);
  bridge.stop();
});


test('persistent room receipts preserve the per-turn message limit', async t => {
  const f = fixture(t); let sent = 0;
  const tool = roomMessageDelivery(async () => { sent++; return '{"status":"sent"}'; }, () => f.store.scoped(target, 'rooms'));
  for (let i = 0; i < 32; i++) await tool({ action: 'send', room: '!shared:test', id: `m-${i}`, text: 'Message' }, signal());
  await assert.rejects(tool({ action: 'send', room: '!shared:test', id: 'extra', text: 'Message' }, signal()), /limit reached/);
  assert.equal(sent, 32);
});
