// Notification persistence failures must remain retryable.
// Only temporary fixtures are modified; no Matrix, GitHub, model or real processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundTasks } from '../src/background-tasks.js';
import { createConfirmationJobs } from '../src/decision-jobs.js';

const target = { room: '!private:test', sender: '@human:test', key: 'linked-key', session: 'session' };
const signal = () => new AbortController().signal;
function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'riftjack-audit-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('notification admission retries after failed persistence and survives restart', t => {
  const root = fixture(t), file = join(root, 'background.json');
  const queue = new BackgroundTasks(file, root);
  // Force one deterministic write failure, then restore the writable location.
  mkdirSync(file + '.tmp');
  const notify = () => queue.notify('result-1', target, 'Completed operation', { group: 'operation-1', progress: false });
  assert.throws(notify);
  assert.equal(JSON.parse(queue.action({ action: 'list' }, target, signal())).length, 0);
  rmSync(file + '.tmp', { recursive: true });
  assert.doesNotThrow(notify);
  assert.equal(JSON.parse(queue.action({ action: 'list' }, target, signal())).length, 1);
  assert.equal(JSON.parse(new BackgroundTasks(file, root).action({ action: 'list' }, target, signal())).length, 1);
});

test('approval result is marked notified only after its notification is persisted', t => {
  const root = fixture(t), file = join(root, 'background.json'), jobsFile = join(root, 'jobs.json');
  const queue = new BackgroundTasks(file, root), errors: unknown[] = [];
  writeFileSync(jobsFile, JSON.stringify({ version: 1, jobs: [{
    id: '00000000-0000-0000-0000-000000000001', target, input: { question: 'Test only' },
    state: 'approved', created: Date.now(), expires: Date.now() + 10000,
    result: '{"status":"approved"}', notified: false,
  }] }));
  const options = { timeoutMs: 10000, valid: () => true, authorize: async () => {}, send: async () => {},
    notify: (id: string, scope: typeof target, message: string) => queue.notify(id, scope, message, { group: id, progress: false }),
    report: (error: unknown) => { errors.push(error); } };
  const jobs = createConfirmationJobs(jobsFile, options);
  mkdirSync(file + '.tmp'); jobs.pump(); assert.equal(errors.length, 1);
  assert.equal(JSON.parse(readFileSync(jobsFile, 'utf8')).jobs[0].notified, false);
  rmSync(file + '.tmp', { recursive: true }); jobs.pump();
  assert.equal(JSON.parse(readFileSync(jobsFile, 'utf8')).jobs[0].notified, true);
  const recovered = new BackgroundTasks(file, root);
  let redeliveries = 0;
  createConfirmationJobs(jobsFile, { ...options, notify: () => { redeliveries++; } }).pump();
  assert.equal(redeliveries, 0);
  assert.equal(JSON.parse(recovered.action({ action: 'list' }, target, signal())).length, 1);
});

