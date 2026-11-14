import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State, type Pending } from '../src/state.js';

const message: Pending = { room: '!room:example.com', feedback: false,
  event: { event_id: '$message', sender: '@alice:example.com', content: { body: 'Continue' } } };

for (const stage of ['write', 'rename'] as const) {
  for (const operation of ['dequeue', 'claim', 'capture', 'complete', 'session'] as const) {
    test(`${operation} remains retryable after state ${stage} failure`, t => {
      const root = mkdtempSync(join(tmpdir(), 'state-failure-')), file = join(root, 'state.json');
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const state = new State(file);
      state.update('session', { codex: 'original' });
      if (operation === 'dequeue' || operation === 'complete') state.enqueue('bot', message);
      if (operation === 'complete') state.rememberMessage('bot', message);
      const attempt = () => {
        if (operation === 'dequeue') return state.dequeueBatch('bot');
        if (operation === 'claim') return state.claim('claim-id');
        if (operation === 'capture') return state.rememberMessage('bot', message);
        if (operation === 'complete') return state.completeMessages('bot', ['$message']);
        return state.update('session', { codex: 'replacement' });
      };
      if (stage === 'write') mkdirSync(file + '.tmp');
      else { renameSync(file, file + '.backup'); mkdirSync(file); }
      assert.throws(attempt);
      if (stage === 'write') rmSync(file + '.tmp', { recursive: true });
      else { rmSync(file, { recursive: true }); renameSync(file + '.backup', file); }
      // A later unrelated save must not persist a mutation whose caller saw failure.
      state.update('other-session', { claude: 'other' });
      const restarted = new State(file);
      assert.deepEqual(restarted.session('session'), { codex: 'original' });
      if (operation === 'dequeue' || operation === 'complete') {
        assert.equal(state.queued('bot'), 1); assert.equal(restarted.queued('bot'), 1);
      }
      if (operation === 'complete') assert.equal(restarted.recoverable('bot').length, 1);
      if (operation === 'capture') assert.equal(restarted.recoverable('bot').length, 0);
      const result = attempt();
      if (operation === 'claim') assert.equal(result, true);
      if (operation === 'dequeue') assert.deepEqual(result, [message]);
      const final = new State(file);
      if (operation === 'claim') assert.equal(final.claim('claim-id'), false);
      if (operation === 'capture') assert.equal(final.recoverable('bot').length, 1);
      if (operation === 'complete') assert.equal(final.recoverable('bot').length, 0);
      if (operation === 'session') assert.deepEqual(final.session('session'), { codex: 'replacement' });
    });
  }
}
