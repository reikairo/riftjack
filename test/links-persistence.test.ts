import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationLinks, PEER_CREDIT } from '../src/conversation-links.js';
import { State } from '../src/state.js';
import { GRANT, sessionKey, type MatrixEvent } from '../src/bridge.js';

const owner = '@owner:example.com', bot = '@bot:example.com', peer = '@peer:example.com';
const home = '!home:example.com', room = '!shared:example.com';
const event = (id: string, sender = owner): MatrixEvent => ({ type: 'm.room.message', event_id: id, sender,
  origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: id } });

for (const stage of ['write', 'rename'] as const) {
  for (const operation of ['observe', 'acknowledge', 'credit', 'reserve', 'mention'] as const) {
    test(`failed linked-room ${operation} at ${stage} remains retryable`, t => {
      const root = mkdtempSync(join(tmpdir(), 'links-persistence-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const path = join(root, 'links.json'), file = join(root, 'history.json');
      const state = new State(join(root, 'state.json'));
      state.update(sessionKey(home, event('$home')), { codex: 'session' });
      writeFileSync(path, JSON.stringify({ version: 1, agents: [{ bot, owner, home, session: 'session' }],
        rooms: [{ room, owner, bots: [bot, peer] }] }));
      const load = () => new ConversationLinks(path, file, [{ userId: bot, name: 'Bot', kind: 'codex', accessToken: 'test' }], state, owner);
      const links = load();
      links.observe(bot, room, event('$initial', peer));
      const prompt = (instance = links) => JSON.parse(instance.prompt(bot, home, event('$question'), 'Question').split('\n')[1]);
      const incoming = event('$mention', peer);
      // A configured remote peer grants a single invocation with no remaining credit.
      Object.assign(incoming.content!, { 'm.mentions': { user_ids: [bot] },
        [GRANT]: { version: 1, id: 'grant-1', from: peer, to: bot, room, remaining: 0, since: Date.now() } });
      if (operation === 'reserve') links.credit(bot);
      if (operation === 'acknowledge') prompt();
      if (operation === 'mention') links.observe(bot, room, incoming);
      const change = () => {
        if (operation === 'observe') return links.observe(bot, room, event('$new', peer));
        if (operation === 'acknowledge') return links.acknowledge(bot);
        if (operation === 'credit') return links.credit(bot);
        if (operation === 'reserve') return links.reserve(bot, room);
        return links.mention(bot, room, incoming);
      };
      if (stage === 'write') mkdirSync(file + '.tmp');
      else { renameSync(file, file + '.backup'); mkdirSync(file); }
      assert.throws(change);
      if (stage === 'write') rmSync(file + '.tmp', { recursive: true });
      else { rmSync(file, { recursive: true }); renameSync(file + '.backup', file); }
      if (operation === 'acknowledge') {
        // Retry the same delivery acknowledgement, without preparing a new prompt.
        change();
        assert.equal(prompt(load()).unreadSharedMessages, undefined);
      } else if (operation === 'observe') {
        links.note(bot, room, 'Unrelated save');
        assert.ok(!prompt(load()).unreadSharedMessages.some((e: { id: string }) => e.id === '$new'));
        assert.equal(change(), true);
      } else if (operation === 'credit') {
        assert.equal(links.peerCredit(bot), 0);
        change(); assert.equal(load().peerCredit(bot), PEER_CREDIT);
      } else if (operation === 'reserve') {
        assert.equal(links.peerCredit(bot), PEER_CREDIT);
        assert.ok(change()); assert.equal(load().peerCredit(bot), PEER_CREDIT - 1);
      } else {
        assert.ok(change());
        assert.equal(links.mention(bot, room, incoming), undefined);
      }
    });
  }
}
