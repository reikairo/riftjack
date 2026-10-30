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



test('busy model delivery does not block other observations or room reminders', async t => {
  const root = fixture(t), file = join(root, 'background.json');
  const queue = new BackgroundTasks(file, root);
  queue.notify('agent-result', target, 'Model work', { group: 'model-work', progress: false });
  let release!: () => void, started!: () => void, posts = 0, turns = 0;
  const pending = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { started = r; });
  const options = { valid: () => true, report: (e: unknown) => { throw e; },
    deliver: async (_target: unknown, _event: unknown, admitted: () => void) => {
      if (turns) return false;
      turns++; admitted(); started(); await pending; return true;
    },
    post: async (_target: unknown, _text: unknown, admitted: () => void) => { admitted(); posts++; return true; } };
  const running = queue.pump(options);
  await entered;
  const reminder = JSON.parse(queue.action({ action: 'remind', label: 'Room reminder', message: 'Due now', deliver: 'room', delay_minutes: 1 }, target, signal()));
  writeFileSync(join(root, 'status.json'), '{"status":"complete"}');
  queue.action({ action: 'watch', label: 'Build', status_file: 'status.json', field: 'status', terminal: ['complete'] }, target, signal());
  await queue.pump(options, Date.parse(reminder.due));
  assert.equal(posts, 1);
  assert.equal(turns, 1, 'ongoing delivery is not duplicated');
  writeFileSync(join(root, 'status.json'), '{"status":"running"}');
  release(); await running;
  const restored = new BackgroundTasks(file, root);
  const delivered: string[] = [];
  await restored.pump({ ...options, deliver: async (_t, message, admit) => {
    delivered.push(message.content!.body!); admit(); return true;
  } });
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /"status":"complete"/);
  assert.doesNotMatch(delivered[0], /previous notification turn/, 'unadmitted observations are not interrupted turns');
  assert.equal(posts, 1);
});
