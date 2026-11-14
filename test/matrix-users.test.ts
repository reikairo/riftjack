import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { createMatrixUser, parseUserCreation } from '../src/matrix-users.js';
import { replyContent } from '../src/message-format.js';
import type { Interact } from '../src/interactions.js';
import { Bridge, type MatrixEvent } from '../src/bridge.js';
import { State } from '../src/state.js';

for (const stage of ['write', 'rename']) test(`created user retains recovery password after failed status ${stage}`, async t => {
  const f = fixture(t), write = fs.writeFileSync;
  let password = '';
  const fetcher: typeof fetch = async (url, init) => {
    if (init?.method === 'PUT') password = JSON.parse(String(init.body)).password;
    return f.options.fetcher(url, init);
  };
  if (stage === 'write') t.mock.method(fs, 'writeFileSync', ((path: any, data: any, options: any) => {
    if (typeof data === 'string' && JSON.parse(data).status === 'created') {
      write(path, '{', options);
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    return write(path, data, options);
  }) as typeof fs.writeFileSync);
  else t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('rename failed'), { code: 'EIO' }); });
  syncBuiltinESMExports();
  let failure: unknown;
  try {
    await createMatrixUser(f.config, f.request, { ...f.options, fetcher }).catch(error => { failure = error; });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  const folder = join(f.root, 'created-users'), files = readdirSync(folder);
  assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(join(folder, files[0]), 'utf8'));
  assert.equal(record.status, 'pending'); assert.equal(record.password, password);
  assert.equal(f.calls.filter(c => c.init?.method === 'PUT').length, 1);
  assert.ok(failure instanceof Error); assert.match(failure.message, /created.*recovery/i);
});

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'matrix-users-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://chat.example', MATRIX_OWNER_ID: '@owner:example',
    RIFTJACK_WORKSPACE: process.cwd(), DATA_DIR: root, SYNAPSE_ADMIN_TOKEN: 'secret-admin', SYNAPSE_ADMIN_URL: 'http://127.0.0.1:18008' });
  const calls: { url: string; init?: RequestInit }[] = [];
  const prompts: string[] = [];
  const fetcher = (async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/whoami')) return Response.json({ user_id: '@admin:example' });
    if (String(url).endsWith('/register') && init?.method === 'GET') return Response.json({ nonce: 'nonce' });
    if (init?.method === 'GET') return Response.json({}, { status: 404 });
    return Response.json({ name: '@alice:example', user_id: '@alice:example' }, { status: 201 });
  }) as typeof fetch;
  const controller = new AbortController();
  const options = { sender: config.owner, signal: controller.signal, fetcher,
    interact: (async request => { prompts.push(request.text); return request.approve!; }) as Interact };
  const request = { username: 'alice', name: 'Alice' };
  return { config, options, request, calls, prompts, root, controller };
}

test('human registration command parses names but cannot request admin flags or passwords', () => {
  assert.deepEqual(parseUserCreation('create user alice'), { username: 'alice', name: 'alice' });
  for (const name of ['Alice 🦊', 'Алиса', 'アリス', 'أليس', 'Cafe\u0301']) {
    assert.deepEqual(parseUserCreation(`Create a Matrix user alice named ${name}`), { username: 'alice', name });
  }
  for (const command of ['create user Alice', 'create user @alice:example', 'create user alice admin', 'create user alice password secret', 'create user ../alice', 'create user alice named a\nb', 'create user']) {
    assert.throws(() => parseUserCreation(command), /Use /);
  }
  assert.equal(parseUserCreation('create a Codex bot called Alice'), null);
  assert.equal(parseUserCreation('allow @alice:example'), null);
});

test('owner-approved creation uses local server identity and creates no login or bot access', async t => {
  const f = fixture(t);
  const result = await createMatrixUser(f.config, f.request, f.options);
  assert.match(f.prompts[0], /@alice:example/);
  assert.match(f.prompts[0], /no administrator privileges or bot access/);
  const writes = f.calls.filter(c => c.init?.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, 'http://127.0.0.1:18008/_synapse/admin/v2/users/%40alice%3Aexample');
  const body = JSON.parse(String(writes[0].init!.body));
  assert.equal(body.admin, false); assert.equal(body.displayname, 'Alice');
  assert.match(body.password, /^[\w-]{32}$/);
  assert.equal(f.calls.filter(c => c.url.includes('/users/') && c.init?.method === 'GET').length, 2);
  assert.ok(f.calls.every(c => c.init?.redirect === 'error'));
  assert.ok(!f.calls.some(c => c.url.endsWith('/login')));
  assert.deepEqual(readdirSync(f.root), ['created-users']);
  const folder = join(f.root, 'created-users'), record = join(folder, readdirSync(folder)[0]);
  const stored = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(stored.status, 'created'); assert.equal(stored.password, body.password);
  assert.equal(statSync(record).mode & 0o777, 0o600);
  assert.equal(statSync(folder).mode & 0o777, 0o700);
  const plain = replyContent(result, true).map(p => p.body).join('');
  assert.ok(plain.includes(body.password)); assert.ok(plain.includes('allow @alice:example'));
  assert.ok(!f.prompts[0].includes(body.password));
});

test('shared-secret path signs an ordinary account and suppresses login', async t => {
  const f = fixture(t);
  await createMatrixUser({ ...f.config, registrationSecret: 'registration-secret' }, f.request, f.options);
  const writes = f.calls.filter(c => c.init?.method !== 'GET');
  assert.equal(writes.length, 1); assert.ok(writes[0].url.endsWith('/_synapse/admin/v1/register'));
  const body = JSON.parse(String(writes[0].init!.body));
  assert.equal(body.admin, false); assert.equal(body.inhibit_login, true);
  assert.equal(body.mac, createHmac('sha1', 'registration-secret').update(['nonce', 'alice', body.password, 'notadmin'].join('\0')).digest('hex'));
});

test('non-owner, missing credentials and missing confirmation channel fail before network access', async t => {
  const f = fixture(t);
  await assert.rejects(createMatrixUser(f.config, f.request, { ...f.options, sender: '@other:example' }), /Only the initial owner/);
  await assert.rejects(createMatrixUser({ ...f.config, adminToken: undefined }, f.request, f.options), /SYNAPSE_ADMIN_TOKEN/);
  await assert.rejects(createMatrixUser(f.config, f.request, { ...f.options, interact: undefined }), /confirmation/);
  assert.equal(f.calls.length, 0);
});

for (const when of ['before', 'after']) test(`occupied username ${when} confirmation prevents writes`, async t => {
  const f = fixture(t);
  let checks = 0;
  const fetcher = (async (url, init) => {
    if (String(url).includes('/users/') && ++checks >= (when === 'before' ? 1 : 2)) return Response.json({ name: '@alice:example' });
    return f.options.fetcher(url, init);
  }) as typeof fetch;
  await assert.rejects(createMatrixUser(f.config, f.request, { ...f.options, fetcher }), /already exists/);
  assert.ok(f.calls.every(c => c.init?.method === 'GET'));
  assert.equal(f.prompts.length, when === 'before' ? 0 : 1);
  assert.deepEqual(readdirSync(f.root), []);
});

test('decline, aborted confirmation and withdrawal do not create accounts or save passwords', async t => {
  const f = fixture(t);
  const declined = await createMatrixUser(f.config, f.request, { ...f.options, interact: async request => request.deny });
  assert.match(declined, /cancelled/);
  await assert.rejects(createMatrixUser(f.config, f.request, { ...f.options, interact: async () => { throw new Error('withdrawn'); } }), /withdrawn/);
  await assert.rejects(createMatrixUser(f.config, f.request, { ...f.options, interact: async () => { f.controller.abort(); return { approved: true }; } }));
  assert.ok(f.calls.every(c => c.init?.method === 'GET'));
  assert.deepEqual(readdirSync(f.root), []);
});

for (const failure of ['network', 'http', 'malformed', 'identity']) test(`uncertain ${failure} result retains recovery credentials and never retries`, async t => {
  const f = fixture(t);
  let password = '', writes = 0;
  const fetcher = (async (url, init) => {
    if (init?.method === 'PUT') {
      writes++;
      password = JSON.parse(String(init.body)).password;
      if (failure === 'network') throw new TypeError(password + ' secret-admin', { cause: { code: 'ECONNRESET' } });
      if (failure === 'http') return Response.json({ error: password + ' secret-admin' }, { status: 500 });
      if (failure === 'malformed') return new Response(password, { status: 201 });
      return Response.json({ name: '@unexpected:example' }, { status: 201 });
    }
    return f.options.fetcher(url, init);
  }) as typeof fetch;
  await assert.rejects(createMatrixUser(f.config, f.request, { ...f.options, fetcher }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /may/);
    assert.ok(!error.message.includes(password)); assert.ok(!error.message.includes('secret-admin'));
    return true;
  });
  const folder = join(f.root, 'created-users');
  const record = JSON.parse(readFileSync(join(folder, readdirSync(folder)[0]), 'utf8'));
  assert.equal(record.password, password); assert.equal(record.status, 'pending');
  await assert.rejects(createMatrixUser(f.config, f.request, { ...f.options, fetcher }), /creation attempt/);
  assert.equal(writes, 1);
});

test('admin denial and non-JSON availability response cannot lead to account creation', async t => {
  const f = fixture(t);
  for (const status of [403, 200]) {
    const fetcher = (async (url, init) => String(url).includes('/users/')
      ? new Response('secret-admin', { status }) : f.options.fetcher(url, init)) as typeof fetch;
    await assert.rejects(createMatrixUser(f.config, f.request, { ...f.options, fetcher }), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes('secret-admin')); return true;
    });
  }
  assert.equal(f.prompts.length, 0); assert.deepEqual(readdirSync(f.root), []);
});

for (const emoji of ['✅', '❌']) test(`manager creation completes via ${emoji} without a model call`, async t => {
  const f = fixture(t);
  let bound!: () => void;
  const ready = new Promise<void>(resolve => { bound = resolve; });
  const replies: string[] = [], errors: unknown[] = [];
  const bridge = new Bridge({ botId: '@manager:example', owner: f.config.owner, kind: 'manager', since: 1000,
    timeoutMs: 5000, state: new State(join(f.root, 'state.json')), isAuthorized: sender => sender === f.config.owner,
    isPrivateRoom: async () => true,
    run: async (_mode, prompt, _key, signal, sender, _files, interact) => createMatrixUser(f.config, parseUserCreation(prompt)!, { ...f.options, signal, sender, interact }),
    confirmation: async (_room, _event, _text, controls) => { controls.bind('$request'); bound(); },
    reply: async (_room, _event, text) => { replies.push(text); }, report: error => errors.push(error),
  });
  t.after(() => bridge.stop());
  const event: MatrixEvent = { type: 'm.room.message', event_id: '$create', sender: f.config.owner, origin_server_ts: 2000, content: { msgtype: 'm.text', body: 'create user alice' } };
  const task = bridge.handle('!dm:example', event);
  await ready;
  assert.ok(f.calls.every(c => c.init?.method === 'GET'));
  const reaction: MatrixEvent = { type: 'm.reaction', event_id: '$decision', sender: f.config.owner, origin_server_ts: 2001,
    content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$request', key: emoji } } };
  await bridge.handle('!dm:example', reaction);
  await task;
  await bridge.handle('!dm:example', event);
  await bridge.handle('!dm:example', reaction);
  assert.equal(f.calls.filter(c => c.init?.method === 'PUT').length, emoji === '✅' ? 1 : 0);
  assert.ok(replies.some(text => text.includes(emoji === '✅' ? 'Password:' : 'cancelled')));
  assert.deepEqual(errors, []);
});
