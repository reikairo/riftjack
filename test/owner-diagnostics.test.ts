import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnerDiagnosticError, PublicError, compactErrorMessage } from '../src/errors.js';
import { OwnerDiagnosticDelivery, ownerReport, type DiagnosticTransport } from '../src/owner-diagnostics.js';
import { isPrivateRoom } from '../src/private-room.js';
import { SERVICE } from '../src/bridge.js';

function fixture(overrides: Partial<DiagnosticTransport> = {}, now = Date.now, idle = 3_600_000, capacity = 100) {
  const messages: any[] = [], files: string[] = [], reactions: any[] = [], removed: string[] = [];
  const transport: DiagnosticTransport = {
    allowed: async () => true, stopping: () => false,
    prepare: async (text, name, authorize) => { await authorize(); files.push(text); return { msgtype: 'm.file', filename: name, file: { url: 'mxc://test/encrypted' } }; },
    send: async (room, content) => { messages.push({ room, ...content }); return '$message' + messages.length; },
    react: async (room, event, key) => { reactions.push({ room, event, key }); return '$reaction' + reactions.length; },
    remove: async (_room, event) => { removed.push(event); }, ...overrides,
  };
  return { delivery: new OwnerDiagnosticDelivery(transport, now, idle, capacity), messages, files, reactions, removed };
}

test('long Unicode diagnostics go in one attachment with a bounded service caption', async () => {
  const details = '<b>original</b> ' + 'Ошибка🙂'.repeat(20_000);
  const error = new OwnerDiagnosticError('Task failed.', details);
  const f = fixture();
  await f.delivery.task(error, 'owner', 'owner', 'home');
  assert.equal(f.messages.length, 1); assert.equal(f.files.length, 1);
  const body = JSON.parse(f.files[0].slice(f.files[0].indexOf('{')));
  assert.equal(body.providerDetails, details);
  assert.equal(f.messages[0].msgtype, 'm.file');
  assert.match(f.messages[0].body, /Task failed/); assert.ok(f.messages[0].body.length < 500);
  assert.doesNotMatch(f.messages[0].body, /original|Ошибка|errorDetails/);
  assert.equal(f.messages[0][SERVICE], true); assert.deepEqual(f.messages[0]['m.mentions'], {});
  assert.equal(f.messages[0].formatted_body, undefined);
});

test('diagnostics require owner identity and a current encrypted two-person room', async () => {
  let extraMember = false, encrypted = true, authorized = true, stopping = false;
  const client = { getRoomState: async () => [
    { type: 'm.room.encryption', state_key: '', content: { algorithm: encrypted ? 'm.megolm.v1.aes-sha2' : '' } },
    { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
    { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
    ...['@bot:test', '@owner:test', ...extraMember ? ['@peer:test'] : []].map(id =>
      ({ type: 'm.room.member', state_key: id, content: { membership: 'join' } })),
  ] };
  const f = fixture({ allowed: room => isPrivateRoom(client, room, '@bot:test', '@owner:test', () => authorized), stopping: () => stopping });
  const error = new OwnerDiagnosticError('Failed', 'full text');
  const send = () => f.delivery.task(error, '@owner:test', '@owner:test', '!home:test');
  assert.equal(await f.delivery.task(error, '@guest:test', '@owner:test', '!home:test'), false);
  assert.equal(f.messages.length, 0); assert.equal(f.files.length, 0);
  await send(); assert.equal(f.messages.length, 1);
  extraMember = true; await assert.rejects(send(), /withheld/);
  extraMember = false; encrypted = false; await assert.rejects(send(), /withheld/);
  encrypted = true; authorized = false; await assert.rejects(send(), /withheld/);
  authorized = true; stopping = true; await assert.rejects(send(), /withheld/);
  assert.equal(f.messages.length, 1); assert.equal(f.reactions.length, 0);
});

test('privacy is checked after upload, and uncertain sends are not replayed', async () => {
  let allowed = true;
  const f = fixture({ allowed: async () => allowed, prepare: async () => { allowed = false; return { msgtype: 'm.file' }; } });
  await assert.rejects(f.delivery.text('details', 'home'), /withheld/);
  assert.equal(f.messages.length, 0);
  let attempts = 0;
  const failed = fixture({ send: async () => { attempts++; throw new Error('uncertain'); } });
  await assert.rejects(failed.delivery.text('details', 'home'), /uncertain/);
  assert.equal(attempts, 1);
});

test('attachment failure leaves one short notice, never inline details', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture({ prepare: async () => { throw new Error('upload failed'); } });
  await f.delivery.task(new OwnerDiagnosticError('Task failed.', 'private details'.repeat(1000)), 'owner', 'owner', 'home');
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].msgtype, 'm.notice');
  assert.match(f.messages[0].body, /attachment unavailable/); assert.doesNotMatch(f.messages[0].body, /private details/);
});

test('ordinary stacks and causes remain in the file, not in chat captions', async () => {
  const error = new Error('request failed', { cause: new Error('socket detail') });
  const f = fixture();
  await f.delivery.task(error, 'owner', 'owner', 'home', { operation: 'matrix.request', bot: '@bot:test' });
  assert.match(f.files[0], /request failed/); assert.match(f.files[0], /socket detail/);
  assert.match(f.files[0], /@bot:test/); assert.doesNotMatch(f.messages[0].body, /socket detail|request failed/);
});

test('twenty identical failures update a single +N reaction under the first report', async () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) await f.delivery.task(new PublicError('Authentication failed.'), 'owner', 'owner', 'home');
  assert.equal(f.messages.length, 1); assert.equal(f.files.length, 1);
  assert.deepEqual(f.reactions.map(r => r.key), Array.from({ length: 19 }, (_, i) => '+' + (i + 1)));
  assert.ok(f.reactions.every(r => r.event === '$message1'));
  assert.deepEqual(f.removed, Array.from({ length: 18 }, (_, i) => '$reaction' + (i + 1)));
  await f.delivery.task(new PublicError('Quota exceeded.'), 'owner', 'owner', 'home');
  assert.equal(f.messages.length, 2);
  await f.delivery.task(new PublicError('Authentication failed.'), 'owner', 'owner', 'home');
  assert.equal(f.messages.length, 3);
});

test('grouped background occurrences add to the badge and room histories stay separate', async () => {
  const f = fixture();
  const report = ownerReport(new Error('failure'), { operation: 'sync', bot: '@bot:test' });
  await f.delivery.send({ ...report, count: 3 }, 'home');
  assert.match(f.messages[0].body, /Occurrences: 3/);
  await f.delivery.send({ ...report, count: 5 }, 'home');
  await f.delivery.send({ ...report, count: 2 }, 'home');
  assert.deepEqual(f.reactions.map(r => r.key), ['+5', '+7']);
  await f.delivery.send(report, 'other-home'); assert.equal(f.messages.length, 2);
});

test('concurrent task and background deliveries cannot create duplicate reports', async () => {
  const f = fixture();
  const report = ownerReport(new Error('failure'), { operation: 'sync' });
  await Promise.all(Array.from({ length: 5 }, () => f.delivery.send(report, 'home')));
  assert.equal(f.messages.length, 1); assert.equal(f.reactions.at(-1).key, '+4');
});

test('idle expiry and bounded room state start fresh reports', async () => {
  let now = 0;
  const f = fixture({}, () => now, 100, 1);
  await f.delivery.text('same', 'home'); now = 100;
  await f.delivery.text('same', 'home'); assert.equal(f.messages.length, 2);
  await f.delivery.text('same', 'other');
  await f.delivery.text('same', 'home'); assert.equal(f.messages.length, 4);
});

test('reaction failure neither spams reports nor bypasses the next privacy check', async t => {
  t.mock.method(console, 'error', () => {});
  let allowed = true, reactions = 0;
  const f = fixture({ allowed: async () => allowed, react: async () => { reactions++; throw new Error('uncertain'); } });
  await f.delivery.text('same', 'home'); await f.delivery.text('same', 'home');
  assert.equal(f.messages.length, 1); assert.equal(reactions, 1);
  allowed = false; await assert.rejects(f.delivery.text('same', 'home'), /withheld/);
  assert.equal(reactions, 1);
});

test('invocation IDs do not split repeated Claude failures and long summaries stay bounded', () => {
  const a = new PublicError('Claude could not authenticate. Local Claude diagnostic ID: a; host log: local');
  const b = new PublicError('Claude could not authenticate. Local Claude diagnostic ID: b; host log: local');
  assert.equal(ownerReport(a, { operation: 'task.failure' }).key, ownerReport(b, { operation: 'task.failure' }).key);
  assert.equal(compactErrorMessage(a), 'Claude could not authenticate.');
  assert.ok(Array.from(compactErrorMessage(new PublicError('🙂'.repeat(2000)))).length <= 350);
});

test('revocation after counter removal prevents sending the new reaction', async t => {
  t.mock.method(console, 'error', () => {});
  let allowed = true;
  const f = fixture({ allowed: async () => allowed, remove: async () => { allowed = false; } });
  await f.delivery.text('same', 'home'); await f.delivery.text('same', 'home');
  await f.delivery.text('same', 'home');
  assert.equal(f.messages.length, 1); assert.equal(f.reactions.length, 1);
});
