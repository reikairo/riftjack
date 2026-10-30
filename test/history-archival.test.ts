import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryReceipts } from '../src/delivery-receipts.js';
import { DetachedRuns } from '../src/detached-runs.js';
const target = { room: '!room:test', sender: '@alice:test', key: 'key', session: 'session' };
function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'riftjack-archive-')));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
function receipts(file: string) {
  const records = Array.from({ length: 1000 }, (_, i) => ({ id: 'old-' + i, scope: target, kind: 'rooms',
    fingerprint: createHash('sha256').update('body').digest('hex'), created: i, status: i === 999 ? 'uncertain' : 'sent', result: '{"status":"sent"}' }));
  writeFileSync(file, JSON.stringify({ version: 1, records }));
}
test('archival frees receipt capacity while preserving lookup, scope and deduplication after restart', async t => {
  const root = fixture(t), file = join(root, 'receipts.json'); receipts(file);
  let sends = 0;
  await new DeliveryReceipts(file).scoped(target, 'rooms').run('new', 'body', async () => { sends++; return '{"status":"sent"}'; });
  assert.equal(sends, 1);
  const saved = JSON.parse(readFileSync(file, 'utf8')).records;
  assert.equal(saved.length, 601);
  assert.ok(saved.some((r: any) => r.id === 'old-999'), 'uncertainty is kept in active index');
  const store = new DeliveryReceipts(file), scope = store.scoped(target, 'rooms');
  assert.equal(JSON.parse(scope.read('old-0')).status, 'sent');
  await scope.run('old-0', 'body', async () => { assert.fail('must not resend archived id'); });
  assert.throws(() => scope.run('old-0', 'changed', async () => ''), /different content/);
  assert.throws(() => store.scoped({ ...target, room: '!other:test' }, 'rooms').read('old-0'), /not found/);
});
test('interrupted archive commit preserves receipts and can be retried', async t => {
  const root = fixture(t), file = join(root, 'receipts.json'); receipts(file);
  const store = new DeliveryReceipts(file).scoped(target, 'rooms');
  mkdirSync(file + '.tmp');
  assert.throws(() => store.run('new', 'body', async () => { assert.fail(); return ''; }));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).records.length, 1000);
  rmSync(file + '.tmp', { recursive: true });
  await store.run('new', 'body', async () => '{"status":"sent"}');
  await new DeliveryReceipts(file).scoped(target, 'rooms').run('old-0', 'body', async () => { assert.fail(); return ''; });
});
test('finished reported runs archive without losing status or logs; lost runs stay indexed', async t => {
  const root = fixture(t), directory = join(root, 'runs'); mkdirSync(directory);
  const runs = Array.from({ length: 100 }, (_, i) => ({ id: randomUUID(), target, label: 'run ' + i, created: i,
    launchBy: 0, sha256: 'a'.repeat(64), notified: i === 99 ? 'lost' : 'succeeded' }));
  for (const r of runs) {
    mkdirSync(join(directory, r.id));
    writeFileSync(join(directory, r.id, 'status.json'), JSON.stringify({ id: r.id, status: r.notified }));
    writeFileSync(join(directory, r.id, 'output.log'), 'kept output');
  }
  writeFileSync(join(directory, 'index.json'), JSON.stringify({ version: 1, runs }));
  const hooks = { processTable: () => [], notify: () => {} }, signal = new AbortController().signal;
  const manager = new DetachedRuns(directory, root, hooks);
  await manager.action({ action: 'start', label: 'new', cwd: root, argv: [process.execPath, '-e', ''] }, target, signal, async r => r.approve!, async () => {});
  const index = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8')).runs;
  assert.equal(index.length, 61); assert.ok(index.some((r: any) => r.id === runs[99].id));
  const restored = new DetachedRuns(directory, root, hooks);
  const status = JSON.parse(await restored.action({ action: 'status', id: runs[0].id }, target, signal, async () => ({}), async () => {}));
  assert.equal(status.status, 'succeeded'); assert.match(status.log_tail, /kept output/);
  await assert.rejects(restored.action({ action: 'status', id: runs[0].id }, { ...target, room: '!other:test' }, signal, async () => ({}), async () => {}), /not found/);
});
