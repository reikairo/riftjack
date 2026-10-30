import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfirmationJobs, createRunApprovalJobs } from '../src/decision-jobs.js';
import type { ApprovalJobOptions } from '../src/approval-jobs.js';
import { DetachedRuns } from '../src/detached-runs.js';
import { Bridge, type MatrixEvent } from '../src/bridge.js';
import { State } from '../src/state.js';
const target = { room: '!home:test', sender: '@alice:test', key: 'key', session: 'session', thread: '$thread' };
const signal = () => new AbortController().signal;
async function until(check: () => boolean) { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('Condition not reached'); }
function fixture(t: { after(fn: () => void): void }, timeoutMs = 10000) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'durable-approvals-')));
  const notices: string[] = [], requests: string[] = [], errors: unknown[] = [];
  const options: Pick<ApprovalJobOptions, 'timeoutMs' | 'valid' | 'authorize' | 'send' | 'notify' | 'report'> = {
    timeoutMs, valid: () => true, authorize: async () => {},
    send: async (_target, _request, text, controls) => { controls.bind('$review-' + requests.length); requests.push(text); },
    notify: (_id, _target, text) => { notices.push(text); }, report: error => { errors.push(error); },
  };
  const questions = createConfirmationJobs(join(dir, 'questions.json'), options);
  const runs = new DetachedRuns(join(dir, 'runs'), dir, { notify: () => {}, processTable: () => [] });
  const launches = createRunApprovalJobs(join(dir, 'approvals.json'), options, runs);
  t.after(async () => { questions.stop(); launches.stop(); await new Promise(r => setImmediate(r)); rmSync(dir, { recursive: true, force: true }); });
  return { dir, options, notices, requests, errors, questions, launches, runs };
}

test('a general question survives the submitting turn and retains its full approved proposal', async t => {
  const f = fixture(t), turn = new AbortController();
  const input = { question: 'Perform the proposed change?', details: 'Exact scope. '.repeat(900) };
  const receipt = JSON.parse(await f.questions.start(input, target, turn.signal)); turn.abort();
  await until(() => f.requests.length === 1);
  assert.equal(receipt.status, 'preparing');
  await f.questions.answer(target, '!approve'); await until(() => f.notices.length === 1);
  const saved = JSON.parse(f.questions.status(target, receipt.request_id));
  assert.equal(saved.state, 'approved'); assert.equal(JSON.parse(saved.result).details, input.details);
  assert.match(f.notices[0], /"truncated":true/); assert.ok(f.notices[0].length <= 4000);
  const recovered = createConfirmationJobs(join(f.dir, 'questions.json'), f.options);
  assert.equal(recovered.status(target, receipt.request_id), f.questions.status(target, receipt.request_id));
  recovered.pump(); assert.equal(f.notices.length, 1);
  assert.throws(() => recovered.status({ ...target, session: 'other' }, receipt.request_id), /not found/);
});

test('unanswered questions expire on restart and cannot be approved by an old id', async t => {
  const f = fixture(t);
  const receipt = JSON.parse(await f.questions.start({ question: 'Proceed?' }, target, signal()));
  await until(() => f.requests.length === 1);
  const snapshot = readFileSync(join(f.dir, 'questions.json'));
  f.questions.stop(); await until(() => f.notices.length === 1);
  writeFileSync(join(f.dir, 'questions.json'), snapshot);
  const recovered = createConfirmationJobs(join(f.dir, 'questions.json'), f.options);
  assert.equal(await recovered.answer(target, '!approve'), undefined);
  assert.equal(JSON.parse(recovered.status(target, receipt.request_id)).state, 'interrupted');
});

test('question deadline is independent of the submitting turn and never becomes consent', async t => {
  const f = fixture(t);
  const receipt = JSON.parse(await f.questions.start({ question: 'Proceed?', timeout_seconds: 1 }, target, signal()));
  await until(() => f.notices.length === 1);
  assert.equal(JSON.parse(f.questions.status(target, receipt.request_id)).state, 'expired');
  assert.equal(await f.questions.answer(target, '!approve'), undefined);
});

test('late launch approval prepares a saved launch with captured script bytes and starts nothing', async t => {
  const f = fixture(t), turn = new AbortController();
  const script = join(f.dir, 'job.js'), marker = join(f.dir, 'executed');
  const original = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`;
  writeFileSync(script, original);
  const receipt = JSON.parse(await f.launches.start({ action: 'start', label: 'Test', cwd: f.dir,
    argv: [process.execPath, script], snapshot_args: [1] }, target, turn.signal));
  turn.abort(); await until(() => f.requests.length === 1);
  writeFileSync(script, 'throw new Error("Changed after review");');
  await f.launches.answer(target, '!approve'); await until(() => f.notices.length === 1);
  const outcome = JSON.parse(f.launches.status(target, receipt.operation_id));
  assert.equal(outcome.state, 'prepared');
  const result = JSON.parse(outcome.result);
  assert.equal(result.launch_argv[0], process.execPath); assert.equal(existsSync(marker), false);
  const command = JSON.parse(readFileSync(join(result.launch_argv[2], 'command.json'), 'utf8'));
  assert.equal(readFileSync(command.argv[1], 'utf8'), original);
  const status = JSON.parse(await f.runs.action({ action: 'status', id: result.id }, target, signal(), async () => ({}), async () => {}));
  assert.equal(status.status, 'prepared');
  assert.equal(existsSync(join(result.launch_argv[2], 'claimed')), false);
});

test('hour-long approval and delivery waits preserve a fixed launch deadline across restart', async t => {
  const hour = 60 * 60_000, f = fixture(t, 24 * hour);
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const receipt = JSON.parse(await f.launches.start({ action: 'start', label: 'Delayed build', cwd: f.dir,
    argv: [process.execPath, '-e', 'process.exit(0)'] }, target, signal()));
  await until(() => f.requests.length === 1);
  assert.match(f.requests[0], /24 hours after this approval/);
  now += hour; // The human answers the first question an hour later.
  await f.launches.answer(target, '!approve'); await until(() => f.notices.length === 1);
  const saved = JSON.parse(f.launches.status(target, receipt.operation_id));
  const run = JSON.parse(saved.result), deadline = now + 24 * hour;
  assert.equal(Date.parse(run.launch_by), deadline);
  now += 90 * 60_000; // Result delivery or the ordinary tool's permission can wait too.
  const recovered = new DetachedRuns(join(f.dir, 'runs'), f.dir, { notify() {}, processTable: () => [] });
  const status = async () => JSON.parse(await recovered.action({ action: 'status', id: run.id }, target, signal(), async () => ({}), async () => {}));
  assert.equal((await status()).status, 'prepared');
  assert.equal(existsSync(join(run.launch_argv[2], 'claimed')), false);
  assert.equal(JSON.parse(f.launches.status(target, receipt.operation_id)).result, saved.result);
  assert.equal(JSON.parse(readFileSync(join(run.launch_argv[2], 'command.json'), 'utf8')).launch_by, deadline);
  now = deadline + 1;
  assert.equal((await status()).reason, 'launch_expired');
  // Status reads and reconstructed managers never renew an expired approval.
  assert.equal((await status()).reason, 'launch_expired');
});

test('bridge routes delayed question decisions and retrieves the saved decision in a later turn', async t => {
  const f = fixture(t), state = new State(join(f.dir, 'state.json')); state.update(target.key, { codex: target.session });
  let requestId = '', turns = 0, saved = '';
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 10000, state, confirmationJobs: f.questions,
    isAuthorized: sender => sender === target.sender, isPrivateRoom: async () => true, linkedSession: () => target.key,
    reply: async () => {}, report: error => { throw error; },
    run: async (_mode, _prompt, _key, signal, _sender, _files, _interact, _publish, hooks) => {
      if (++turns === 1) requestId = JSON.parse(await hooks!.confirmation!({ question: 'Proceed?' }, signal)).request_id;
      else saved = await hooks!.confirmation!({ action: 'status', id: requestId }, signal);
      return 'Done';
    },
  });
  const event = (body: string, id: string): MatrixEvent => ({ type: 'm.room.message', sender: target.sender, event_id: id,
    origin_server_ts: Date.now(), content: { body, msgtype: 'm.text', 'm.relates_to': { rel_type: 'm.thread', event_id: target.thread } } });
  await bridge.handle(target.room, event('Ask', '$first')); await until(() => f.requests.length === 1);
  assert.equal(bridge.busy, false);
  await bridge.handle(target.room, event('!approve', '$approval')); await until(() => f.notices.length === 1);
  await bridge.handle(target.room, event('Read decision', '$second'));
  assert.equal(JSON.parse(saved).state, 'approved');
});
