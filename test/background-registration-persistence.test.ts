import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundTasks } from '../src/background-tasks.js';

const target = { room: '!home:test', sender: '@alice:test', key: 'key', session: 'session' };
const signal = new AbortController().signal;
const reminder = { action: 'remind', label: 'Check', message: 'Inspect results', deliver: 'agent', delay_minutes: 1 };
function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'background-registration-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'queue.json'), queue = new BackgroundTasks(file, root);
  const action = (input: unknown) => JSON.parse(queue.action(input, target, signal));
  const list = () => action({ action: 'list' });
  const block = () => mkdirSync(file + '.tmp');
  const unblock = () => rmSync(file + '.tmp', { recursive: true });
  const restored = () => JSON.parse(new BackgroundTasks(file, root).action({ action: 'list' }, target, signal));
  return { root, queue, action, list, block, unblock, restored };
}
for (const kind of ['reminder', 'file', 'conditions']) test(`failed ${kind} registration remains absent and retryable`, async t => {
  const f = fixture(t), status = join(f.root, 'status.json');
  writeFileSync(status, '{"state":"running"}');
  const input = kind === 'reminder' ? reminder : kind === 'file'
    ? { action: 'watch', label: 'File', status_file: status, field: 'state', terminal: ['done'] }
    : { action: 'watch', mode: 'idle', label: 'Idle', idle_file: status, idle_seconds: 60 };
  f.block();
  assert.throws(() => f.action(input));
  assert.deepEqual(f.list(), []);
  f.unblock();
  assert.deepEqual(f.restored(), []);
  const saved = f.action(input);
  assert.equal(saved.alreadyWatching, undefined);
  assert.equal(f.restored().length, 1);
});
for (const operation of ['update', 'cancel', 'cancel-notification']) test(`failed ${operation} keeps the saved reminder active`, t => {
  const f = fixture(t);
  if (operation === 'cancel-notification') f.queue.notify('notice', target, 'Inspect result', { group: 'group', progress: false });
  else f.action(reminder);
  const before = f.list(), id = before[0].id;
  const change = () => operation === 'cancel-notification' ? f.queue.cancelNotifications('group', target)
    : f.action(operation === 'cancel' ? { action: 'cancel', id } : { ...reminder, action: 'update', id, label: 'Changed' });
  f.block(); assert.throws(change);
  assert.deepEqual(f.list(), before);
  f.unblock(); assert.deepEqual(f.restored(), before);
  change();
  assert.deepEqual(f.list(), f.restored());
  if (operation === 'update') assert.equal(f.list()[0].label, 'Changed');
  else assert.deepEqual(f.list(), []);
});
