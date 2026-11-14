import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { WorkerQueue } from '../../src/worker-queue.js';
import { WorkerService } from '../../src/worker-service.js';
import { WorkerServer } from '../../src/worker-server.js';
import { WorkerBridge, workerInitiative, workerTaskAllowed } from '../../src/worker-bridge.js';
import { State } from '../../src/state.js';
import { diagnosticRecord } from '../../src/diagnostics.js';

const event = (id = '$one', body = 'hello') => ({ type: 'm.room.message', event_id: id, sender: '@alice:test', origin_server_ts: 1000, content: { msgtype: 'm.text', body } });
function directory(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'riftjack-worker-http-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
const idle = async (service: WorkerService) => { while (service.busy) await new Promise(resolve => setTimeout(resolve, 1)); };

test('worker HTTP failures identify authorization and recover without changing the task', async t => {
  const dir = directory(t), queue = new WorkerQueue(join(dir, 'queue.sqlite'));
  const records: ReturnType<typeof diagnosticRecord>[] = [];
  let offline = true;
  const error = Object.assign(new Error('private-server-response'), { code: 'ETIMEDOUT', syscall: 'read' });
  const service = new WorkerService(queue, join(dir, 'files'), 100, {
    allowed: async () => { if (offline) throw error; return true; },
    receive: async () => undefined, prepare: async () => [], send: async () => {}, report: () => {},
  });
  const candidate = queue.enqueue('!private-room:test', event('$private-event', 'private-message'), 'private-conversation');
  const server = new WorkerServer((error, context) => { records.push(diagnosticRecord(error, context)); });
  server.add('@private-bot:test', 'a'.repeat(43), service);
  const port = await server.start(0);
  t.after(async () => { service.stop(); await server.stop(); queue.close(); });
  const url = `http://127.0.0.1:${port}/v1/bots/%40private-bot%3Atest/tasks`;
  const request = () => fetch(url, { headers: { Authorization: 'Bearer ' + 'a'.repeat(43) } });
  const failure = await request();
  assert.equal(failure.status, 503);
  assert.match((await failure.json() as { error: string }).error, /ETIMEDOUT/);
  assert.equal(records[0].operation, 'worker.claim');
  assert.equal(records[0].failedOperation, 'worker.authorize');
  assert.deepEqual(records[0].operations, ['worker.http', 'worker.claim', 'worker.authorize']);
  assert.ok(records[0].bot); assert.ok(records[0].task);
  assert.doesNotMatch(JSON.stringify(records), /private-|Bearer|aaaa/);
  offline = false;
  const success = await request();
  assert.equal(success.status, 200);
  assert.equal((await success.json() as { task: { id: string } }).task.id, candidate.id);
  assert.equal(records.length, 1);
});

test('Python client can initiate from a finished task without a lease, with per-bot HTTP authorization', async t => {
  const dir = directory(t), queue = new WorkerQueue(join(dir, 'queue.sqlite'));
  const state = new State(join(dir, 'state.json')), bot = '@grok:test';
  const service = new WorkerService(queue, join(dir, 'files'), 100, {
    initiative: { intervalMs: 60_000, prepare: (source, text, id) => workerInitiative(source, text, id, bot) },
    allowed: task => workerTaskAllowed(task, { bot, state, stopping: () => false, allowed: async () => true }),
    receive: async () => undefined, prepare: async () => [], send: async () => {}, report: () => {},
  });
  const bridge = new WorkerBridge({ botId: bot, state, queue, service, authorized: () => true,
    privateRoom: async () => true, reply: async () => {} });
  await bridge.handle('!home:test', event('$source'));
  const source = (await service.claim())!;
  await service.complete(source.id, source.lease!, { text: 'Done.' }); await idle(service);
  const server = new WorkerServer(); server.add(bot, 'a'.repeat(43), service);
  const otherQueue = new WorkerQueue(join(dir, 'other.sqlite'));
  const other = new WorkerService(otherQueue, join(dir, 'other'), 100, {
    initiative: { intervalMs: 60_000, prepare: (s, text, id) => workerInitiative(s, text, id, '@other:test') },
    allowed: async () => true, receive: async () => undefined, prepare: async () => [], send: async () => {}, report: () => {},
  });
  server.add('@other:test', 'b'.repeat(43), other);
  const port = await server.start(0);
  t.after(async () => { service.stop(); other.stop(); await server.stop(); queue.close(); otherQueue.close(); });
  const base = `http://127.0.0.1:${port}/v1/bots/%40grok%3Atest/tasks/${source.id}/initiate`;
  const post = (url: string, token: string, body: unknown, origin?: string) => fetch(url, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(origin && { Origin: origin }) },
    body: JSON.stringify(body),
  });
  const request = { id: 'note', text: 'Work completed.' };
  assert.equal((await post(base, 'b'.repeat(43), request)).status, 401);
  assert.equal((await post(base.replace('grok', 'other'), 'b'.repeat(43), request)).status, 404);
  assert.equal((await post(base, 'a'.repeat(43), request, 'https://example.org')).status, 403);
  assert.equal((await post(base, 'a'.repeat(43), { ...request, room: '!other:test' })).status, 400);
  const tokenFile = join(dir, 'token'), sourceFile = join(dir, 'source.json'), noteFile = join(dir, 'note.txt');
  writeFileSync(tokenFile, 'a'.repeat(43), { mode: 0o600 });
  writeFileSync(sourceFile, JSON.stringify({ id: source.id })); // No lease is required.
  writeFileSync(noteFile, 'A durable background note.');
  const cli = (...args: string[]) => promisify(execFile)('python3', [fileURLToPath(new URL('../../scripts/worker-client.py', import.meta.url)),
    '--url', `http://127.0.0.1:${port}`, '--bot', bot, '--token-file', tokenFile, ...args]);
  const receipt = JSON.parse((await cli('initiate', sourceFile, '--id', 'cli-note', '--text-file', noteFile)).stdout);
  const retry = JSON.parse((await cli('initiate', sourceFile, '--id', 'cli-note', '--text-file', noteFile)).stdout);
  assert.equal(receipt.id, retry.id); assert.equal(receipt.status, 'queued');
  assert.equal((await post(base, 'a'.repeat(43), request)).status, 429);
  const task = JSON.parse((await cli('wait', '--seconds', '1')).stdout);
  assert.equal(task.id, receipt.id); assert.equal(task.conversation, source.conversation);
  assert.match(task.text, /not a new human message or approval/);
  assert.match(task.text, /A durable background note/);
  assert.equal((await fetch(base.replace('/initiate', '/rooms').replace(source.id, task.id), {
    method: 'POST', headers: { Authorization: 'Bearer ' + 'a'.repeat(43) },
    body: JSON.stringify({ request: { action: 'list' } }),
  })).status, 400);
});

test('worker HTTP API authenticates per bot, supports long polling, and validates replies', async t => {
  const dir = realpathSync(directory(t)), queue = new WorkerQueue(join(dir, 'queue.sqlite'));
  const audioPath = join(dir, 'voice.ogg'); writeFileSync(audioPath, 'audio');
  const transcription = { status: 'complete' as const, text: 'Example speech.', automatic: true as const };
  const service = new WorkerService(queue, join(dir, 'files'), 10, { allowed: async () => true,
    receive: async () => ({ path: audioPath, name: 'voice.ogg', image: false, mimetype: 'audio/ogg', size: 5 }),
    transcribe: async file => ({ ...file, transcription }),
    prepare: async task => [{ text: task.response!.text }], send: async () => {}, report: () => {} });
  const server = new WorkerServer(); server.add('@grok:test', 'a'.repeat(43), service);
  const port = await server.start(0);
  t.after(async () => { service.stop(); await server.stop(); queue.close(); });
  const base = `http://127.0.0.1:${port}/v1/bots/%40grok%3Atest/tasks`;
  const request = (path = '', body?: object, token = 'a'.repeat(43)) => fetch(base + path, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(body && { method: 'POST', body: JSON.stringify(body) }),
  });
  assert.equal((await request('', undefined, 'b'.repeat(43))).status, 401);
  assert.equal((await fetch(base.replace('grok', 'other'), { headers: { Authorization: 'Bearer ' + 'a'.repeat(43) } })).status, 401);
  const waiting = request('?wait=2');
  setTimeout(() => queue.enqueue('!dm:test', event(), 'c'), 20);
  const task = (await (await waiting).json()).task;
  assert.ok(task.id); assert.equal(task.text, 'hello');
  assert.deepEqual(await (await request()).json(), { task: null });
  assert.equal((await request('/' + task.id + '/reply', { lease: 'wrong', text: 'reply' })).status, 409);
  assert.equal((await request('/' + task.id + '/reply', { lease: task.lease, files: [{ name: 'x', data: Buffer.alloc(11).toString('base64') }] })).status, 413);
  assert.equal((await request('/' + task.id + '/reply', { lease: task.lease, text: 'reply' })).status, 200);
  await idle(service);
  assert.equal((await (await request('/' + task.id)).json()).status, 'delivered');
  assert.equal((await request('/' + task.id + '/reply', { lease: task.lease, text: 'different' })).status, 409);
  const tokenFile = join(dir, 'token'), taskFile = join(dir, 'task.json'), replyFile = join(dir, 'reply.txt');
  writeFileSync(tokenFile, 'a'.repeat(43), { mode: 0o600 }); writeFileSync(replyFile, 'reply from CLI');
  queue.enqueue('!dm:test', event('$cli'), 'c');
  const cli = (...args: string[]) => promisify(execFile)('python3', [fileURLToPath(new URL('../../scripts/worker-client.py', import.meta.url)),
    '--url', `http://127.0.0.1:${port}`, '--bot', '@grok:test', '--token-file', tokenFile, ...args]);
  const claimed = JSON.parse((await cli('wait', '--seconds', '1')).stdout);
  assert.equal(claimed.text, 'hello'); writeFileSync(taskFile, JSON.stringify(claimed));
  assert.ok(JSON.parse((await cli('renew', taskFile)).stdout).leaseUntil);
  const savedAudio = join(dir, 'saved.ogg');
  const saved = JSON.parse((await cli('attachment', taskFile, '--output', savedAudio)).stdout);
  assert.deepEqual(saved.transcription, transcription);
  assert.equal(readFileSync(savedAudio, 'utf8'), 'audio');
  assert.equal(JSON.parse((await cli('reply', taskFile, '--text-file', replyFile)).stdout).status, 'replied');
  await idle(service);
  assert.equal(JSON.parse((await cli('status', taskFile)).stdout).status, 'delivered');
  const bridge = new WorkerBridge({ botId: '@grok:test', authorized: sender => sender === '@alice:test', privateRoom: async () => true,
    queue, service, state: new State(join(dir, 'state.json')), reply: async () => assert.fail('No acknowledgement for reactions'),
    reactionTarget: async () => ({ type: 'm.room.message', event_id: '$answer', sender: '@grok:test',
      content: { msgtype: 'm.text', body: 'Earlier worker answer.', 'm.relates_to': { rel_type: 'm.thread', event_id: '$thread' } } }),
  });
  await bridge.handle('!dm:test', { type: 'm.reaction', event_id: '$like', sender: '@alice:test', origin_server_ts: 1000,
    content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$answer', key: '❤️' } } });
  const feedback = (await (await request()).json()).task;
  assert.match(feedback.text, /strong appreciation or support/); assert.match(feedback.text, /Earlier worker answer/);
  assert.ok(feedback.conversation.includes('$thread'));

});

test('worker service failures expose a safe cause without leaking exception text', async t => {
  const server = new WorkerServer();
  server.add('@worker:test', 'a'.repeat(43), { claim: async () => {
    throw Object.assign(new Error('private database path and token'), { code: 'ENOSPC', syscall: 'write' });
  } } as unknown as WorkerService);
  const port = await server.start(0);
  t.after(() => server.stop());
  const response = await fetch(`http://127.0.0.1:${port}/v1/bots/%40worker%3Atest/tasks`, {
    headers: { Authorization: 'Bearer ' + 'a'.repeat(43) },
  });
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.match(body, /ENOSPC.*write/);
  assert.doesNotMatch(body, /private database|token/);
});

test('worker room endpoint and Python client keep operations scoped to a live lease and transfer file bytes', async t => {
  const dir = realpathSync(directory(t)), queue = new WorkerQueue(join(dir, 'queue.sqlite'));
  const seen: any[] = []; let allowed = true;
  const incoming = join(dir, 'incoming.txt'); writeFileSync(incoming, 'download');
  const service = new WorkerService(queue, join(dir, 'files'), 100, {
    allowed: async () => allowed, receive: async () => undefined, prepare: async () => [], send: async () => {}, report: () => {},
    roomAllowed: async () => allowed,
    rooms: async (_task, request, _signal, guard, outbox) => {
      await guard(); const r = request as any; seen.push(r);
      if (r.action === 'send_files') {
        assert.equal(readFileSync(join(outbox, r.files[0].path), 'utf8'), 'upload');
        return JSON.stringify({ files: [{ status: 'sent' }] });
      }
      if (r.action === 'receive_attachment') return JSON.stringify({ file: { path: incoming, name: 'incoming.txt', mimetype: 'text/plain' } });
      return JSON.stringify({ rooms: [{ room: '!team:test', type: 'shared', agents: ['@grok:test', '@peer:test'] }] });
    },
  });
  const server = new WorkerServer(); server.add('@grok:test', 'a'.repeat(43), service);
  const port = await server.start(0);
  t.after(async () => { service.stop(); await server.stop(); queue.close(); });
  const task = queue.claim(queue.enqueue('!team:test', event(), 'conversation').id)!;
  const url = `http://127.0.0.1:${port}/v1/bots/%40grok%3Atest/tasks/${task.id}/rooms`;
  const request = (lease: string, token = 'a'.repeat(43), operation: unknown = { action: 'list' }) => fetch(url, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ lease, request: operation }),
  });
  assert.equal((await request(task.lease!, 'b'.repeat(43))).status, 401);
  assert.equal((await request('stale')).status, 409); assert.equal(seen.length, 0);
  assert.equal((await request(task.lease!)).status, 200);
  assert.equal((await request(task.lease!, undefined, { action: 'send_files', room: '!team:test', id: 'bad', files: [{ path: incoming }] })).status, 400);
  const tokenFile = join(dir, 'token'), taskFile = join(dir, 'task.json'), operationFile = join(dir, 'operation.json');
  writeFileSync(tokenFile, 'a'.repeat(43), { mode: 0o600 }); writeFileSync(taskFile, JSON.stringify(task));
  const cli = (...args: string[]) => promisify(execFile)('python3', [fileURLToPath(new URL('../../scripts/worker-client.py', import.meta.url)),
    '--url', `http://127.0.0.1:${port}`, '--bot', '@grok:test', '--token-file', tokenFile, 'rooms', taskFile, '--request-file', operationFile, ...args]);
  writeFileSync(operationFile, JSON.stringify({ action: 'list' }));
  assert.equal(JSON.parse((await cli()).stdout).rooms[0].type, 'shared');
  const upload = join(dir, 'upload.txt'); writeFileSync(upload, 'upload');
  writeFileSync(operationFile, JSON.stringify({ action: 'send_files', room: '!team:test', id: 'upload', files: [{ path: upload }] }));
  assert.equal(JSON.parse((await cli()).stdout).files[0].status, 'sent');
  assert.notEqual(seen.at(-1).files[0].path, upload);
  writeFileSync(operationFile, JSON.stringify({ action: 'receive_attachment', room: '!team:test', event_id: '$file' }));
  const output = join(dir, 'download.txt');
  assert.equal(JSON.parse((await cli('--output', output)).stdout).saved, output);
  assert.equal(readFileSync(output, 'utf8'), 'download');
  await assert.rejects(cli('--output', output)); // No overwrite of local files.
  allowed = false; assert.equal((await request(task.lease!)).status, 403);
  assert.equal(queue.get(task.id).status, 'cancelled');
});
