import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationLinks } from '../../src/conversation-links.js';
import { BackgroundTasks, type BackgroundTarget } from '../../src/background-tasks.js';
import type { MatrixEvent } from '../../src/bridge.js';
import { State } from '../../src/state.js';
import type { ToolContext } from '../../src/tool-conversation.js';

export const bot = '@builder:test', owner = '@alice:test', peer = '@reviewer:test';
export const home = '!home:test', shared = '!shared:test', peerHome = '!peer-home:test';
export const key = JSON.stringify([home, owner, '$home-thread']);
export const signal = () => new AbortController().signal;
export const event = (thread: string | null = '$shared-thread', id = '$source'): MatrixEvent => ({
  type: 'm.room.message', event_id: id, sender: owner, origin_server_ts: Date.now(),
  content: { msgtype: 'm.text', body: 'Check the saved task',
    ...(thread ? { 'm.relates_to': { rel_type: 'm.thread', event_id: thread } } : {}) },
});
export const target = (context: ToolContext): BackgroundTarget => ({ room: context.room,
  sender: context.event.sender!, key: context.key, session: 'pinned-session',
  thread: context.event.content?.['m.relates_to']?.event_id });
export const homeTarget: BackgroundTarget = { room: home, sender: owner, key, session: 'pinned-session', thread: '$home-thread' };

export function linkedToolsFixture(t: { after(fn: () => void): void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'linked-tools-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new State(join(dir, 'state.json'));
  state.update(key, { codex: 'pinned-session' });
  state.update(JSON.stringify([peerHome, owner, null]), { codex: 'peer-session' });
  writeFileSync(join(dir, 'links.json'), JSON.stringify({ version: 1,
    agents: [{ bot, owner, home, session: 'pinned-session', thread: '$home-thread' },
      { bot: peer, owner, home: peerHome, session: 'peer-session' }],
    rooms: [{ room: shared, owner, bots: [bot, peer] }] }));
  const links = new ConversationLinks(join(dir, 'links.json'), join(dir, 'history.json'),
    [bot, peer].map(userId => ({ userId, kind: 'codex' as const, name: 'Builder', accessToken: 'test' })), state, owner);
  const queueFile = join(dir, 'tasks.json'), background = new BackgroundTasks(queueFile, dir);
  return { dir, state, links, queueFile, background };
}
