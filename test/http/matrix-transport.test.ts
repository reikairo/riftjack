import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createSecureServer, type Http2ServerRequest, type Http2ServerResponse, type ServerHttp2Session } from 'node:http2';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { Agent, request, getGlobalDispatcher } from 'undici';
import { getRequestFn, MatrixClient } from '@vector-im/matrix-bot-sdk';
import { installMatrixTransport } from '../../src/matrix-transport.js';
import { matrixTyping } from '../../src/matrix-typing.js';

// Public, test-only self-signed identity. No TLS verification is disabled.
const cert = readFileSync(new URL('../fixtures/matrix-transport-cert.pem', import.meta.url));
const key = readFileSync(new URL('../fixtures/matrix-transport-key.pem', import.meta.url));
async function server(t: TestContext, handler: (req: Http2ServerRequest, res: Http2ServerResponse) => void) {
  const sessions = new Set<ServerHttp2Session>();
  const sockets = new Set<import('node:net').Socket>();
  const server = createSecureServer({ cert, key, allowHTTP1: true }, handler);
  server.on('session', session => { sessions.add(session); session.on('error', () => {}); });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    for (const session of sessions) session.destroy();
    for (const socket of sockets) socket.destroy();
    await closed;
  });
  return `https://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}
function install(t: TestContext, origin: string) {
  const transport = installMatrixTransport('1.1', [origin], options => new Agent({ ...options, connect: { ca: cert } }));
  t.after(() => transport.destroy());
  return transport;
}

test('forced HTTP/1.1 covers SDK and fetch; unrelated requests still negotiate HTTP/2', { timeout: 10_000 }, async t => {
  const seen: { url: string; version: string; body: string; auth?: string }[] = [];
  const origin = await server(t, (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url!, version: req.httpVersion, body, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ user_id: '@bot:example', device_id: 'test', version: req.httpVersion }));
    });
  });
  const before = getGlobalDispatcher();
  const transport = install(t, origin);
  const client = new MatrixClient(origin, 'test-token');
  assert.equal((await client.getWhoAmI()).user_id, '@bot:example');
  await matrixTyping({ homeserver: origin, userId: '@bot:example', accessToken: 'test-token' }, transport.fetch)('!room:example', true, 30000, AbortSignal.timeout(3000));
  const upload: RequestInit & { duplex: 'half' } = {
    method: 'POST', duplex: 'half', body: Readable.from(['by', 'tes']) as unknown as BodyInit,
  };
  const response = await transport.fetch(new Request(origin + '/_matrix/media/v3/upload', upload));
  assert.equal((await response.json()).version, '1.1');
  assert.equal(seen.length, 3);
  assert.ok(seen.every(call => call.version === '1.1'));
  assert.equal(seen[1].auth, 'Bearer test-token');
  assert.equal(JSON.parse(seen[1].body).typing, true);
  assert.equal(seen[2].body, 'bytes');
  assert.equal(getGlobalDispatcher(), before);
  const unrelated = new Agent({ connect: { ca: cert } });
  t.after(() => unrelated.destroy());
  const other = await request(origin + '/unrelated', { dispatcher: unrelated });
  assert.equal((await other.body.json() as any).version, '2.0');
});

test('more than sixteen concurrent syncs do not block messages', { timeout: 10_000 }, async t => {
  const pending: Http2ServerResponse[] = [];
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const origin = await server(t, (req, res) => {
    if (req.url!.startsWith('/_matrix/client/v3/sync')) {
      pending.push(res);
      if (pending.length === 20) ready();
    } else { res.end('{"event_id":"$sent"}'); }
  });
  install(t, origin);
  const polls = Array.from({ length: 20 }, (_, i) => getRequestFn()(origin + '/_matrix/client/v3/sync?since=' + i, { headersTimeout: 5000 }));
  // Attach handlers immediately, including on a failed assertion/cleanup.
  const results = Promise.allSettled(polls.map(async p => (await p).body.text()));
  await started;
  const client = new MatrixClient(origin, 'test-token');
  const sent = await client.doRequest('PUT', '/_matrix/client/v3/rooms/room/send/m.room.message/txn', undefined, { body: 'hello' }, 1000);
  assert.equal(sent.event_id, '$sent');
  for (const res of pending) res.end('{}');
  assert.ok((await results).every(result => result.status === 'fulfilled'));
});

test('timed-out or dropped connections recover without replaying writes; fetch remains abortable', { timeout: 10_000 }, async t => {
  let writes = 0;
  const origin = await server(t, (req, res) => {
    if (req.url === '/stall') return;
    if (req.url === '/write') { writes++; req.socket.destroy(); return; }
    res.end('{"ok":true}');
  });
  const transport = install(t, origin);
  await assert.rejects(getRequestFn()(origin + '/stall', { headersTimeout: 100 }), { code: 'UND_ERR_HEADERS_TIMEOUT' });
  const healthy = await getRequestFn()(origin + '/healthy');
  assert.deepEqual(await healthy.body.json(), { ok: true });
  await assert.rejects(getRequestFn()(origin + '/write', { method: 'POST', body: 'change' }));
  assert.equal(writes, 1);
  await assert.rejects(transport.fetch(origin + '/stall', { signal: AbortSignal.timeout(100) }), { name: 'TimeoutError' });
  assert.deepEqual(await (await transport.fetch(origin + '/healthy')).json(), { ok: true });
});
