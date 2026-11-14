import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatrixError, type MatrixClient } from '@vector-im/matrix-bot-sdk';
import { RateLimitedMatrixClient, matrixRetryDelay } from '../src/rate-limited-matrix-client.js';
import { sendConfirmation } from '../src/confirmation-message.js';
import { Interactions } from '../src/interactions.js';

type Args = Parameters<MatrixClient['doRequest']>;
const limited = (ms = 1000) => new MatrixError({ errcode: 'M_LIMIT_EXCEEDED', error: 'Slow down', retry_after_ms: ms }, 429, {});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
class Client extends RateLimitedMatrixClient {
  calls: Args[] = [];
  waits: number[] = [];
  respond: (args: Args) => Promise<any> = async () => ({});
  onWait: (ms: number) => Promise<void> = async () => {};
  constructor() { super('https://matrix.example.org', 'test-token'); }
  protected override async requestOnce(...args: Args) { this.calls.push(args); return this.respond(args); }
  protected override async waitForRetry(ms: number) { this.waits.push(ms); await this.onWait(ms); }
}

test('rate limit delays honor SDK/header/body hints with bounded fallback', () => {
  assert.equal(matrixRetryDelay(limited(1200), 0), 1200);
  assert.equal(matrixRetryDelay(new MatrixError({ errcode: 'M_LIMIT_EXCEEDED', error: 'Slow down', retry_after_ms: 1000 }, 429,
    { 'retry-after': '3' }), 0), 3000);
  assert.equal(matrixRetryDelay({ statusCode: 429, headers: { 'retry-after': '2' } }, 0), 2000);
  assert.equal(matrixRetryDelay({ statusCode: 429, retryAfterMs: NaN }, 2), 4000);
  assert.equal(matrixRetryDelay({ statusCode: 429, retryAfterMs: 0 }, 0), 250);
  assert.equal(matrixRetryDelay({ statusCode: 403, errcode: 'M_LIMIT_EXCEEDED' }, 0), undefined);
});

test('a retried SDK event retains its transaction ID and exact body', async () => {
  const client = new Client();
  let tries = 0;
  client.respond = async () => { if (++tries === 1) throw limited(2400); return { event_id: '$sent' }; };
  const content = { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$request', key: '✅' } };
  assert.equal(await client.sendRawEvent('!room:example.org', 'm.reaction', content), '$sent');
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0][1], client.calls[1][1]);
  assert.equal(client.calls[0][3], content);
  assert.equal(client.calls[1][3], content);
  assert.deepEqual(client.waits, [2400]);
});

test('event cooldown queues other sends but allows authorization reads', async () => {
  const client = new Client();
  const waiting = gate(), release = gate();
  client.onWait = async () => { waiting.resolve(); await release.promise; };
  let sends = 0;
  client.respond = async ([method]) => {
    if (method === 'PUT' && ++sends === 1) throw limited();
    return { event_id: '$event' };
  };
  const first = client.sendRawEvent('!room:example.org', 'm.reaction', {});
  await waiting.promise;
  const second = client.sendRawEvent('!room:example.org', 'm.reaction', {});
  await client.doRequest('GET', '/_matrix/client/v3/rooms/room/state');
  assert.equal(sends, 1);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(sends, 3);
});

test('persistent 429 terminates, preserves its cause, and releases the event queue', async () => {
  const client = new Client(), error = limited();
  client.respond = async () => { throw error; };
  await assert.rejects(client.sendRawEvent('!room:example.org', 'm.reaction', {}), e => e === error);
  assert.equal(client.calls.length, 6);
  client.respond = async () => ({ event_id: '$next' });
  assert.equal(await client.sendRawEvent('!room:example.org', 'm.reaction', {}), '$next');
  client.respond = async () => { throw limited(61_000); };
  const before = client.waits.length;
  await assert.rejects(client.doRequest('GET', '/state'));
  assert.equal(client.waits.length, before, 'never retry earlier than requested by server');
});

test('network errors, forbidden responses, sync and typing are not retried', async () => {
  for (const error of [new Error('offline'), { statusCode: 403 }, { statusCode: 500 }]) {
    const client = new Client();
    client.respond = async () => { throw error; };
    await assert.rejects(client.doRequest('GET', '/state'), e => e === error);
    assert.equal(client.calls.length, 1);
  }
  for (const endpoint of ['/_matrix/client/v3/sync', '/_matrix/client/v3/rooms/room/typing/user']) {
    const client = new Client();
    client.respond = async () => { throw limited(); };
    await assert.rejects(client.doRequest('GET', endpoint));
    assert.equal(client.calls.length, 1);
  }
});

test('stopping aborts cooldown and queued sends without sending them', async () => {
  class StoppingClient extends RateLimitedMatrixClient {
    calls = 0;
    waiting = gate();
    protected override async requestOnce() { this.calls++; throw limited(10_000); }
    protected override waitForRetry(ms: number) { this.waiting.resolve(); return super.waitForRetry(ms); }
  }
  const client = new StoppingClient('https://matrix.example.org', 'test-token');
  const first = client.sendRawEvent('!room:example.org', 'm.reaction', {});
  await client.waiting.promise;
  const second = client.sendRawEvent('!room:example.org', 'm.reaction', {});
  const done = Promise.allSettled([first, second]);
  client.stop();
  assert.deepEqual((await done).map(r => r.status), ['rejected', 'rejected']);
  assert.equal(client.calls, 1);
});

test('twelve sequential approvals survive 429 on messages, seeds and permission reads', async () => {
  const client = new Client(), interactions = new Interactions();
  const attempted = new Set<string>();
  const seeds: string[] = [];
  let event = 0;
  client.respond = async ([method, endpoint, , body]) => {
    const key = method + endpoint;
    if (!attempted.has(key)) { attempted.add(key); throw limited(); }
    if (endpoint.includes('/send/m.reaction/')) seeds.push(body['m.relates_to'].key);
    return { event_id: '$' + ++event };
  };
  for (let i = 0; i < 12; i++) {
    let target = '';
    const result = await interactions.ask({ text: 'Approve action?', approve: { approved: true }, deny: {} },
      new AbortController().signal, async (text, controls, markdown) => {
        await sendConfirmation(text, controls, {
          authorize: async () => { await client.doRequest('GET', '/_matrix/client/v3/rooms/room/state'); },
          sendMessage: async content => (target = await client.sendRawEvent('!room:example.org', 'm.room.message', content)),
          sendReaction: (id, key) => client.sendRawEvent('!room:example.org', 'm.reaction', {
            'm.relates_to': { rel_type: 'm.annotation', event_id: id, key } }),
          report: error => { throw error; },
        }, markdown);
        assert.match(interactions.react(target, '✅')!, /Answer sent/);
      });
    assert.deepEqual(result, { approved: true });
    assert.equal(interactions.size, 0);
  }
  assert.deepEqual(seeds, Array.from({ length: 12 }, () => ['✅', '❌']).flat());
});

test('manual approval remains actionable while a seed is rate limited', async () => {
  const client = new Client(), interactions = new Interactions();
  let delivered!: Promise<void>;
  let target = '', seedAttempts = 0, authorizations = 0;
  client.respond = async ([, endpoint]) => {
    if (endpoint.includes('/send/m.reaction/') && ++seedAttempts === 1) throw limited();
    return { event_id: '$request' };
  };
  client.onWait = async () => {
    await client.doRequest('GET', '/_matrix/client/v3/rooms/room/state');
    assert.match(interactions.react(target, '✅')!, /Answer sent/);
  };
  const result = await interactions.ask({ text: 'Approve action?', approve: { approved: true }, deny: {} },
    new AbortController().signal, (text, controls) => delivered = sendConfirmation(text, controls, {
      authorize: async () => {
        assert.ok(++authorizations <= 2, 'no new authorization after manual decision');
      },
      sendMessage: async content => (target = await client.sendRawEvent('!room:example.org', 'm.room.message', content)),
      sendReaction: (id, key) => client.sendRawEvent('!room:example.org', 'm.reaction', { id, key }),
      report: error => { throw error; },
    }));
  assert.deepEqual(result, { approved: true });
  await delivered;
  assert.equal(seedAttempts, 2, 'second seed is skipped once answered');
});
