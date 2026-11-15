import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestartController } from '../src/restart.js';
import { RestartNotice } from '../src/restart-notice.js';
import { hostErrorDetails } from '../src/host-diagnostics.js';
import { Bridge } from '../src/bridge.js';
import { State } from '../src/state.js';

const target = { botId: '@bot:test', roomId: '!room:test', sender: '@owner:test', eventId: '$restart' };

test('failed restart persistence retains the filesystem cause and releases the reservation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'riftjack-restart-errors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const blocker = join(root, 'file'); writeFileSync(blocker, 'not a directory');
  const restart = new RestartController({ supported: true, busy: () => false,
    notice: new RestartNotice(join(blocker, 'notice.json')), shutdown: () => assert.fail('Must not restart') });
  await assert.rejects(restart.request(async () => assert.fail('Must not acknowledge'), target), error => {
    assert.ok(error instanceof Error);
    assert.ok(error.cause instanceof Error);
    assert.ok(hostErrorDetails(error).nodes.some(node => node.syscall === 'mkdir' && typeof node.code === 'string'));
    return true;
  });
  assert.equal(restart.pending, false);
});

test('combined restart failure does not trigger a second acknowledgement through Bridge', async t => {
  const root = mkdtempSync(join(tmpdir(), 'riftjack-restart-errors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const notice = new RestartNotice(join(root, 'notice.json'));
  t.mock.method(notice, 'clear', () => { throw new Error('Cleanup failed'); });
  const restart = new RestartController({ supported: true, busy: () => false, notice,
    shutdown: () => assert.fail('Must not restart') });
  let replies = 0;
  const errors: unknown[] = [];
  const bridge = new Bridge({ botId: target.botId, owner: target.sender, kind: 'codex', since: 0,
    timeoutMs: 1000, state: new State(join(root, 'state.json')), isAuthorized: () => true,
    isPrivateRoom: async () => true, report: error => errors.push(error),
    reply: async () => { if (++replies === 1) throw new Error('Acknowledgement failed'); },
    restart: (reply, destination, scope) => restart.request(reply, destination, scope),
    run: async () => assert.fail('Must not run a model') });
  t.after(() => bridge.stop());
  await bridge.handle(target.roomId, { type: 'm.room.message', event_id: target.eventId,
    sender: target.sender, origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: '!restart' } });
  assert.equal(replies, 1);
  assert.equal(errors.length, 1);
  assert.equal(restart.pending, false);
});

test('failed restart acknowledgement and cleanup both remain available to owner diagnostics', async t => {
  const root = mkdtempSync(join(tmpdir(), 'riftjack-restart-errors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const notice = new RestartNotice(join(root, 'notice.json'));
  const delivery = Object.assign(new Error('Matrix acknowledgement failed'), { code: 'ECONNRESET' });
  const cleanup = Object.assign(new Error('Notice removal failed'), { code: 'EACCES' });
  t.mock.method(notice, 'clear', () => { throw cleanup; });
  const restart = new RestartController({ supported: true, busy: () => false, notice,
    shutdown: () => assert.fail('Must not restart') });
  await assert.rejects(restart.request(async () => { throw delivery; }, target), error => {
    const details = hostErrorDetails(error);
    for (const original of [delivery, cleanup]) {
      assert.ok(details.nodes.some(node => node.message === original.message && node.stack === original.stack));
    }
    return true;
  });
  assert.equal(restart.pending, false);
});
