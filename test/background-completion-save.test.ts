import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundTasks } from '../src/background-tasks.js';

for (const deliver of ['agent', 'room']) test(`completed ${deliver} reminder retries its save without repeating delivery`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'completion-save-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'queue.json'), queue = new BackgroundTasks(file, root);
  const target = { room: '!home:example.com', sender: '@alice:example.com', key: 'key', session: 'session' };
  const signal = new AbortController().signal;
  const saved = JSON.parse(queue.action({ action: 'remind', label: 'Check', message: 'Inspect result', deliver, delay_minutes: 1 }, target, signal));
  t.mock.timers.setTime(Date.parse(saved.due));
  let sent = 0;
  const dispatch = async (_target: unknown, _event: unknown, admit: () => void) => {
    admit(); sent++;
    mkdirSync(file + '.tmp');
    return true;
  };
  await assert.rejects(queue.pump({ valid: () => true, deliver: dispatch, post: dispatch, report: () => {} }), { code: 'EISDIR' });
  assert.equal(sent, 1);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).watches[0].state, 'dispatching');
  const never = async () => assert.fail('completed work must not run again');
  // Failed persistence must remain visible on later pumps until storage recovers.
  await assert.rejects(queue.pump({ valid: () => true, deliver: never, post: never, report: () => {} }), { code: 'EISDIR' });
  rmSync(file + '.tmp', { recursive: true });
  await queue.pump({ valid: () => true, deliver: never, post: never, report: () => {} });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).watches[0].state, 'delivered');
  const restored = new BackgroundTasks(file, root);
  assert.deepEqual(JSON.parse(restored.action({ action: 'list' }, target, signal)), []);
  await restored.pump({ valid: () => true, deliver: never, post: never, report: () => {} });
});
