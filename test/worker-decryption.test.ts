import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimpleFsStorageProvider } from '@vector-im/matrix-bot-sdk';
import { MessageMatrixClient } from '../src/message-matrix-client.js';
import { bindExecutorInbox } from '../src/executor-main.js';

const JOURNAL = 'riftjack.worker.failed_decryptions.v1';
const room = '!room:test';
const reference = (id = '$late') => ({ room, event: id });
const message = (id = '$late', type = 'm.room.message') => ({
  type, event_id: id, sender: '@alice:test', origin_server_ts: 1000,
  content: { msgtype: 'm.text', body: 'hello' },
});
const encrypted = (id = '$late') => ({ ...message(id), type: 'm.room.encrypted', content: {} });
const timeline = (events: unknown[]) => ({ rooms: { join: { [room]: { timeline: { events } } } } });

function storage(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'riftjack-decryption-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Object.assign(new SimpleFsStorageProvider(join(dir, 'matrix.json')), { filePath: join(dir, 'matrix.json') });
}

class Client extends MessageMatrixClient {
  events = new Map<string, any>();
  fetched: string[] = [];
  raw: any = { next_batch: 'next' };
  rawEvents = new Map<string, any>();
  fetchFailure?: Error;
  constructor(store: SimpleFsStorageProvider) {
    super('https://matrix.test', 'synthetic-token', store);
    Object.defineProperty(this, 'crypto', { value: {
      updateSyncData: async () => {},
      isRoomEncrypted: async () => true,
      decryptRoomEvent: async (event: { raw: { event_id: string } }) => {
        if (!this.events.has(event.raw.event_id)) throw new Error('room key unavailable');
        return { raw: this.events.get(event.raw.event_id) };
      },
    } });
  }
  batch(raw: any) { return super.processSync(raw); }
  async run() {
    await this.startSyncInternal();
    await new Promise(resolve => setImmediate(resolve));
  }
  protected override async doSync() { return this.raw; }
  protected override async processSync(raw: any, emit: any) {
    try { await super.processSync(raw, emit); } finally { this.stop(); }
  }
  override async getRawEvent(_room: string, id: string): Promise<any> {
    this.fetched.push(id);
    if (this.fetchFailure) throw this.fetchFailure;
    return this.rawEvents.get(id) ?? encrypted(id);
  }
}

test('failed decryptions survive restart and re-enter discovery/inbox before the sync checkpoint', async t => {
  const store = storage(t);
  let client = new Client(store);
  await client.batch(timeline([encrypted(), encrypted()]));
  assert.deepEqual(JSON.parse(store.readValue(JOURNAL)!), [reference()]);
  assert.deepEqual(client.fetched, []);

  client = new Client(new SimpleFsStorageProvider(store.filePath));
  await client.batch({});
  assert.deepEqual(JSON.parse(store.readValue(JOURNAL)!), [reference()]);

  const resumed = new SimpleFsStorageProvider(store.filePath);
  resumed.setSyncToken('previous');
  client = new Client(resumed);
  client.events.set('$late', message());
  const order: string[] = [];
  client.protocol = async () => { order.push('discovery'); };
  client.inbox = async () => {
    assert.equal(resumed.getSyncToken(), 'previous');
    order.push('inbox');
  };
  await client.run();
  assert.deepEqual(order, ['discovery', 'inbox']);
  assert.equal(resumed.getSyncToken(), 'next');
  assert.deepEqual(JSON.parse(resumed.readValue(JOURNAL)!), []);
  await client.batch({});
  assert.deepEqual(order, ['discovery', 'inbox']);
});

for (const stage of ['protocol', 'inbox'] as const) {
  test(`failed recovered ${stage} admission retains the journal and previous sync checkpoint`, async t => {
    const store = storage(t);
    store.setSyncToken('previous');
    store.storeValue(JOURNAL, JSON.stringify([reference()]));
    const client = new Client(store), failure = new Error('admission write failed');
    client.events.set('$late', message());
    let fatal = 0, inbox = 0;
    client.on('worker.inbox_failure', error => { fatal++; assert.equal(error, failure); });
    client.protocol = async () => { if (stage === 'protocol') throw failure; };
    client.inbox = async () => { inbox++; if (stage === 'inbox') throw failure; };
    await client.run();
    assert.equal(fatal, 1);
    assert.equal(inbox, stage === 'inbox' ? 1 : 0);
    assert.equal(store.getSyncToken(), 'previous');
    assert.deepEqual(JSON.parse(store.readValue(JOURNAL)!), [reference()]);
  });
}

test('a failed journal write stops sync without advancing its checkpoint', async t => {
  const store = storage(t);
  store.setSyncToken('previous');
  const failure = new Error('journal disk unavailable');
  store.storeValue = () => { throw failure; };
  const client = new Client(store);
  client.raw = { next_batch: 'next', ...timeline([encrypted()]) };
  const fatal: unknown[] = [];
  client.on('worker.inbox_failure', error => fatal.push(error));
  await client.run();
  assert.deepEqual(fatal, [failure]);
  assert.equal(store.getSyncToken(), 'previous');
});

test('failure to clear the journal retains its durable references for restart replay', async t => {
  const store = storage(t);
  store.setSyncToken('previous');
  store.storeValue(JOURNAL, JSON.stringify([reference()]));
  const failure = new Error('journal disk unavailable');
  store.storeValue = () => { throw failure; };
  const client = new Client(store);
  client.events.set('$late', message());
  const admitted: string[] = [], fatal: unknown[] = [];
  client.inbox = async (_room, event) => { admitted.push(event.event_id); };
  client.on('worker.inbox_failure', error => fatal.push(error));
  await client.run();
  assert.deepEqual(admitted, ['$late']);
  assert.deepEqual(fatal, [failure]);
  assert.equal(store.getSyncToken(), 'previous');
  assert.deepEqual(JSON.parse(new SimpleFsStorageProvider(store.filePath).readValue(JOURNAL)!), [reference()]);
});

test('bounded retry batches rotate missing keys so later events can recover', async t => {
  const store = storage(t), references = Array.from({ length: 51 }, (_, i) => reference('$event' + i));
  store.storeValue(JOURNAL, JSON.stringify(references));
  const client = new Client(store);
  client.events.set('$event50', message('$event50'));
  const recovered: string[] = [];
  client.on('room.message', (_room, event) => recovered.push(event.event_id));
  await client.batch({});
  assert.equal(client.fetched.length, 50);
  assert.deepEqual(recovered, []);
  await client.batch({});
  assert.equal(client.fetched.length, 100);
  assert.deepEqual(recovered, ['$event50']);
  assert.equal(JSON.parse(store.readValue(JOURNAL)!).length, 50);
});

for (const type of ['m.reaction', 'org.example.protocol']) {
  test(`recovered ${type} events retain discovery ordering and event routing`, async t => {
    const store = storage(t);
    store.storeValue(JOURNAL, JSON.stringify([reference()]));
    const client = new Client(store), order: string[] = [];
    client.events.set('$late', message('$late', type));
    client.protocol = async () => { order.push('discovery'); };
    client.inbox = async () => { order.push('inbox'); };
    await client.run();
    assert.deepEqual(order, type === 'm.reaction' ? ['discovery', 'inbox'] : ['discovery']);
  });
}

test('an unavailable key never evicts an older event to make room in a full journal', async t => {
  const store = storage(t), references = Array.from({ length: 1000 }, (_, i) => reference('$event' + i));
  store.storeValue(JOURNAL, JSON.stringify(references));
  const client = new Client(store);
  await assert.rejects(client.batch(timeline([encrypted()])), /journal is full/);
  assert.deepEqual(JSON.parse(store.readValue(JOURNAL)!), references);
});

test('a corrupt decryption journal fails closed instead of silently resetting pending events', async t => {
  const store = storage(t);
  store.storeValue(JOURNAL, JSON.stringify([{ room, event: 'invalid' }]));
  const client = new Client(store);
  await assert.rejects(client.batch({}), /Invalid failed-decryption journal/);
});

test('plaintext returned for a pending encrypted event never acquires verified-decryption authority', async t => {
  const store = storage(t);
  store.storeValue(JOURNAL, JSON.stringify([reference()]));
  const client = new Client(store), observed: string[] = [];
  client.rawEvents.set('$late', message());
  client.events.set('$late', message());
  client.on('room.decrypted_event', () => observed.push('decrypted'));
  client.protocol = async () => { observed.push('protocol'); };
  bindExecutorInbox(client, { receive: async () => { observed.push('executor'); } }, async () => true);
  await client.run();
  assert.deepEqual(observed, []);
  assert.deepEqual(JSON.parse(store.readValue(JOURNAL)!), [reference()]);
});

test('a transport failure ends the retry batch and retains unattempted events', async t => {
  const store = storage(t), references = [reference('$one'), reference('$two')];
  store.storeValue(JOURNAL, JSON.stringify(references));
  const client = new Client(store);
  client.fetchFailure = new Error('homeserver rate-limit retry budget exhausted');
  await client.batch({});
  assert.deepEqual(client.fetched, ['$one']);
  assert.deepEqual(JSON.parse(store.readValue(JOURNAL)!), [references[1], references[0]]);
  client.fetchFailure = undefined;
  client.events.set('$two', message('$two'));
  const recovered: string[] = [];
  client.on('room.message', (_room, event) => recovered.push(event.event_id));
  await client.batch({});
  assert.deepEqual(recovered, ['$two']);
  assert.deepEqual(JSON.parse(store.readValue(JOURNAL)!), [references[0]]);
});
