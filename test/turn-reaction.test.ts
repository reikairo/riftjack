import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.js';
import { TurnReaction } from '../src/turn-reaction.js';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'turn-reaction-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  return { file, state: new State(file) };
}
const allowed = async () => true;

test('the next task removes the persisted reaction, including after restart and across rooms', async t => {
  const { file, state } = fixture(t), calls: string[] = [];
  const transport = {
    send: async (room: string, id: string) => { calls.push(`send ${room} ${id}`); return '$reaction'; },
    remove: async (room: string, id: string) => { calls.push(`remove ${room} ${id}`); },
  };
  await new TurnReaction(state, '@bot:test', transport).completed('!first:test', '$reply', allowed);
  const restarted = new TurnReaction(new State(file), '@bot:test', transport);
  await restarted.started();
  assert.deepEqual(calls, ['send !first:test $reply', 'remove !first:test $reaction']);
  assert.equal(new State(file).turnReactions('@bot:test')[0], undefined);
  await restarted.completed('!second:test', '$next', allowed);
  assert.equal(calls.at(-1), 'send !second:test $next');
});

test('a task starting during reaction delivery removes it before start resolves', async t => {
  const { state } = fixture(t);
  let finish!: (id: string) => void, sending!: () => void;
  const ready = new Promise<void>(resolve => { sending = resolve; });
  const removed: string[] = [];
  const reaction = new TurnReaction(state, '@bot:test', {
    send: () => { sending(); return new Promise(resolve => { finish = resolve; }); },
    remove: async (_room, id) => { removed.push(id); },
  });
  const complete = reaction.completed('!room:test', '$reply', allowed);
  await ready;
  const start = reaction.started();
  finish('$late');
  await Promise.all([complete, start]);
  assert.deepEqual(removed, ['$late']);
  assert.equal(state.turnReactions('@bot:test')[0], undefined);
});

test('a new task invalidates completion waiting for access checks', async t => {
  const { state } = fixture(t);
  let finish!: (ok: boolean) => void, checking!: () => void;
  const ready = new Promise<void>(resolve => { checking = resolve; });
  const reaction = new TurnReaction(state, '@bot:test', {
    send: async () => { assert.fail('Must not mark a running task'); }, remove: async () => {},
  });
  const complete = reaction.completed('!room:test', '$reply', () => {
    checking(); return new Promise(resolve => { finish = resolve; });
  });
  await ready;
  const start = reaction.started(); finish(true);
  await Promise.all([complete, start]);
});

test('queued work arriving during delivery removes the transient marker', async t => {
  const { state } = fixture(t); let idle = true, removed = false;
  const reaction = new TurnReaction(state, '@bot:test', {
    send: async () => { idle = false; return '$reaction'; },
    remove: async () => { removed = true; },
  });
  await reaction.completed('!room:test', '$reply', async () => idle);
  assert.equal(removed, true);
});

test('failed removal retains the receipt for retry and cannot accumulate markers', async t => {
  const { state } = fixture(t); let fail = true;
  state.saveTurnReactions('@bot:test', [{ room: '!room:test', eventId: '$old' }]);
  const reaction = new TurnReaction(state, '@bot:test', {
    send: async () => { assert.fail('Old marker was not removed'); },
    remove: async () => { if (fail) throw new Error('offline'); },
  });
  await assert.rejects(reaction.started(), /Could not remove/);
  await assert.rejects(reaction.completed('!room:test', '$new', allowed), /Could not remove/);
  assert.equal(state.turnReactions('@bot:test')[0]?.eventId, '$old');
  fail = false; await reaction.started();
  assert.equal(state.turnReactions('@bot:test')[0], undefined);
});

test('disabled or busy completion sends no marker', async t => {
  const { state } = fixture(t);
  const reaction = new TurnReaction(state, '@bot:test', {
    send: async () => { assert.fail('Disabled'); }, remove: async () => {},
  });
  await reaction.completed('!room:test', '$reply', async () => false);
});


test('shared completion mirrors the latest home reply across restart, and start clears both', async t => {
  const { file, state } = fixture(t), calls: string[] = [];
  const transport = {
    send: async (room: string, id: string) => { calls.push(`send ${room} ${id}`); return `${room}-reaction`; },
    remove: async (room: string, id: string) => { calls.push(`remove ${room} ${id}`); },
  };
  const first = new TurnReaction(state, '@bot:test', transport, '!home:test');
  first.rememberReply('!home:test', '$older');
  first.rememberReply('!home:test', '$attachment');
  first.rememberReply('!shared:test', '$unrelated');
  const restored = new State(file);
  const reaction = new TurnReaction(restored, '@bot:test', transport, '!home:test');
  await reaction.completed('!shared:test', '$reply', allowed);
  assert.deepEqual(calls, ['send !shared:test $reply', 'send !home:test $attachment']);
  assert.equal(restored.turnReactions('@bot:test').length, 2);
  await new TurnReaction(new State(file), '@bot:test', transport, '!home:test').started();
  assert.deepEqual(calls.slice(2), ['remove !shared:test !shared:test-reaction', 'remove !home:test !home:test-reaction']);
  assert.deepEqual(new State(file).turnReactions('@bot:test'), []);
});

test('home replies are marked once; absent, changed or inaccessible homes are not mirrored', async t => {
  const { state } = fixture(t), sent: string[] = [];
  const transport = { send: async (room: string) => { sent.push(room); return '$reaction'; }, remove: async () => {} };
  const reaction = new TurnReaction(state, '@bot:test', transport, '!home:test');
  await reaction.completed('!shared:test', '$first', allowed);
  assert.deepEqual(sent.splice(0), ['!shared:test']);
  await reaction.completed('!home:test', '$home', allowed);
  assert.deepEqual(sent.splice(0), ['!home:test']);
  await reaction.completed('!shared:test', '$second', async room => room !== '!home:test');
  assert.deepEqual(sent.splice(0), ['!shared:test']);
  await new TurnReaction(state, '@bot:test', transport, '!different:test').completed('!shared:test', '$third', allowed);
  assert.deepEqual(sent, ['!shared:test']);
});

test('start during the second send retracts both markers', async t => {
  const { state } = fixture(t); const removed: string[] = [];
  let finish!: (id: string) => void, sending!: () => void;
  const ready = new Promise<void>(resolve => { sending = resolve; });
  const reaction = new TurnReaction(state, '@bot:test', {
    send: async room => {
      if (room !== '!home:test') return '$shared';
      sending(); return new Promise(resolve => { finish = resolve; });
    },
    remove: async (_room, id) => { removed.push(id); },
  }, '!home:test');
  reaction.rememberReply('!home:test', '$home');
  const complete = reaction.completed('!shared:test', '$reply', allowed);
  await ready;
  const start = reaction.started(); finish('$home-reaction');
  await Promise.all([complete, start]);
  assert.deepEqual(removed, ['$shared', '$home-reaction']);
  assert.deepEqual(state.turnReactions('@bot:test'), []);
});

test('queued work before the second send also clears the first marker', async t => {
  const { state } = fixture(t); let idle = true, count = 0;
  const removed: string[] = [];
  const reaction = new TurnReaction(state, '@bot:test', {
    send: async () => { count++; return '$reaction'; },
    remove: async (_room, id) => { removed.push(id); },
  }, '!home:test');
  reaction.rememberReply('!home:test', '$home');
  await reaction.completed('!shared:test', '$reply', async room => {
    if (room === '!home:test') idle = false;
    return idle;
  });
  assert.equal(count, 1);
  assert.deepEqual(removed, ['$reaction']);
});

test('failed redaction of one marker still removes the other and retains only the failed receipt', async t => {
  const { state } = fixture(t); const removed: string[] = [];
  state.saveTurnReactions('@bot:test', [{ room: '!shared:test', eventId: '$shared' }, { room: '!home:test', eventId: '$home' }]);
  const reaction = new TurnReaction(state, '@bot:test', {
    send: async () => '$unused',
    remove: async (_room, id) => { if (id === '$shared') throw new Error('offline'); removed.push(id); },
  });
  await assert.rejects(reaction.started(), /Could not remove/);
  assert.deepEqual(removed, ['$home']);
  assert.deepEqual(state.turnReactions('@bot:test'), [{ room: '!shared:test', eventId: '$shared' }]);
});

test('the single persisted marker from the previous version can still be removed', async t => {
  const { file } = fixture(t); const removed: string[] = [];
  writeFileSync(file, JSON.stringify({ version: 1, sessions: {}, seen: [], turnReactions: {
    '@bot:test': { room: '!old:test', eventId: '$old' },
  } }));
  const state = new State(file);
  await new TurnReaction(state, '@bot:test', {
    send: async () => '$unused', remove: async (_room, id) => { removed.push(id); },
  }).started();
  assert.deepEqual(removed, ['$old']);
  assert.deepEqual(new State(file).turnReactions('@bot:test'), []);
});

for (const removalFails of [false, true]) test(`failed receipt persistence retracts the marker and retries failed cleanup (${removalFails})`, async t => {
  const { state } = fixture(t);
  const diskError = Object.assign(new Error('receipt write failed'), { code: 'ENOSPC' });
  const removeError = new Error('redaction offline');
  const save = state.saveTurnReactions.bind(state);
  let writes = 0, offline = removalFails, sends = 0;
  t.mock.method(state, 'saveTurnReactions', (bot: string, markers: Parameters<State['saveTurnReactions']>[1]) => {
    if (++writes === 1) throw diskError;
    return save(bot, markers);
  });
  const removals: string[] = [];
  const reaction = new TurnReaction(state, '@bot:test', {
    send: async () => { sends++; return '$reaction-' + sends; },
    remove: async (_room, id) => { removals.push(id); if (offline) throw removeError; },
  });
  await assert.rejects(reaction.completed('!room:test', '$reply', allowed), error => {
    if (!removalFails) return error === diskError;
    return error instanceof AggregateError && error.errors[0] === diskError;
  });
  assert.deepEqual(removals, ['$reaction-1']);
  assert.equal(sends, 1);
  if (removalFails) {
    await assert.rejects(reaction.completed('!room:test', '$later', allowed), /Could not remove/);
    assert.equal(sends, 1, 'do not accumulate markers while an unsaved receipt remains');
  }
  offline = false;
  await reaction.started();
  assert.deepEqual(state.turnReactions('@bot:test'), []);
  await reaction.completed('!room:test', '$next', allowed);
  assert.equal(sends, 2);
  assert.deepEqual(state.turnReactions('@bot:test'), [{ room: '!room:test', eventId: '$reaction-2' }]);
});

test('a real receipt write failure retracts the sent marker even when cleanup cannot save state', async t => {
  const { file, state } = fixture(t);
  const { mkdirSync } = await import('node:fs');
  const removed: string[] = [];
  const reaction = new TurnReaction(state, '@bot:test', {
    send: async () => { mkdirSync(file + '.tmp'); return '$sent'; },
    remove: async (_room, id) => { removed.push(id); },
  });
  await assert.rejects(reaction.completed('!room:test', '$reply', allowed), error =>
    error instanceof AggregateError && (error.errors[0] as NodeJS.ErrnoException).code === 'EISDIR');
  assert.deepEqual(removed, ['$sent']);
  rmSync(file + '.tmp', { recursive: true });
  await reaction.started();
  assert.deepEqual(new State(file).turnReactions('@bot:test'), []);
});

test('failed persistence of the home mirror clears both the durable and unsaved markers', async t => {
  const { state } = fixture(t), removed: string[] = [];
  const failure = new Error('second receipt failed'), save = state.saveTurnReactions.bind(state);
  let writes = 0;
  t.mock.method(state, 'saveTurnReactions', (bot: string, markers: Parameters<State['saveTurnReactions']>[1]) => {
    if (++writes === 2) throw failure;
    return save(bot, markers);
  });
  const reaction = new TurnReaction(state, '@bot:test', {
    send: async room => room === '!home:test' ? '$home' : '$shared',
    remove: async (_room, id) => { removed.push(id); },
  }, '!home:test');
  reaction.rememberReply('!home:test', '$last-home-reply');
  await assert.rejects(reaction.completed('!shared:test', '$reply', allowed), error => error === failure);
  assert.deepEqual(removed, ['$shared', '$home']);
  assert.deepEqual(state.turnReactions('@bot:test'), []);
});
