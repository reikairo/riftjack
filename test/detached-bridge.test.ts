import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge, type MatrixEvent } from '../src/bridge.js';
import { State } from '../src/state.js';
import { DetachedRuns } from '../src/detached-runs.js';

test('detached launch approval is scoped to its human and room and expires with its turn', async t => {
  const root = mkdtempSync(join(tmpdir(), 'confirmation-bridge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let ready!: () => void;
  const shown = new Promise<void>(resolve => { ready = resolve; });
  const replies: string[] = [];
  let result: string | undefined;
  let savedHook: ((input: unknown, signal: AbortSignal) => Promise<string>) | undefined;
  const manager = new DetachedRuns(join(root, 'runs'), root, { notify() {} });
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 10_000,
    state: new State(join(root, 'state.json')), isAuthorized: user => user === '@alice:test' || user === '@bob:test',
    isPrivateRoom: async () => true, detached: (input, ctx, signal, interact, authorize) => manager.action(input, { key: ctx.key, room: ctx.room, sender: ctx.event.sender!, session: 'fixture' }, signal, interact, authorize),
    confirmation: async (_room, _event, _text, controls) => { controls.bind('$proposal'); ready(); },
    reply: async (_room, _event, text) => { replies.push(text); }, report: () => {},
    run: async (_mode, _prompt, _key, signal, _sender, _attachments, _interact, _publish, hooks) => {
      savedHook = hooks!.detached!;
      result = await savedHook({ action: 'start', label: 'fixture', cwd: root, argv: [process.execPath, '-e', 'console.log(1)'] }, signal);
      return result;
    },
  });
  const task = bridge.handle('!room:test', { type: 'm.room.message', event_id: '$request', sender: '@alice:test',
    origin_server_ts: Date.now(), content: { body: 'Ask me first.', msgtype: 'm.text' } });
  await shown;
  const reaction = (id: string, sender = '@alice:test'): MatrixEvent => ({ type: 'm.reaction', event_id: id, sender,
    origin_server_ts: Date.now(), content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$proposal', key: '✅' } } });
  await bridge.handle('!room:test', reaction('$other-human', '@bob:test'));
  await bridge.handle('!other:test', reaction('$other-room'));
  assert.equal(result, undefined);
  await bridge.handle('!room:test', reaction('$accept'));
  await task;
  assert.equal(JSON.parse(result!).status, 'prepared');
  assert.ok(replies.includes(result!));
  await assert.rejects(savedHook!({ action: 'list' }, new AbortController().signal));
});
