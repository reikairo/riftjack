import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DetachedRuns } from '../src/detached-runs.js';
import { save } from '../scripts/detached-runner.mjs';
import type { Interact } from '../src/interactions.js';

const target = { key: 'room-key', room: '!room:example.com', sender: '@alice:example.com', session: 'session' };
const signal = new AbortController().signal;
const approve: Interact = async request => request.approve!;
function setup() {
  const workspace = mkdtempSync(join(tmpdir(), 'detached-test-'));
  const directory = join(workspace, 'runs');
  const notices: any[] = [];
  const hooks = { processTable: () => [] as any[], notify: (...args: any[]) => { notices.push(args); } };
  const manager = new DetachedRuns(directory, workspace, hooks);
  const request = { action: 'start', label: 'fixture', cwd: workspace, argv: [process.execPath, '-e', 'console.log("hello")'] };
  const action = (input: unknown, interact = approve, t = target, auth = async () => {}) => manager.action(input, t, signal, interact, auth).then(JSON.parse);
  return { workspace, directory, notices, hooks, manager, request, action };
}
test('start stages one reviewed command and script snapshot, but executes nothing', async () => {
  const f = setup();
  const script = join(f.workspace, 'task.mjs'); writeFileSync(script, 'console.log("before")');
  let proposal = '';
  const run = await f.action({ ...f.request, argv: [process.execPath, script], snapshot_args: [1] }, async r => {
    proposal = JSON.stringify(r); writeFileSync(script, 'throw new Error("after")'); return r.approve!;
  });
  assert.equal(run.status, 'prepared'); assert.equal(run.launch_argv[0], process.execPath);
  assert.match(proposal, /survive this turn/);
  const spec = JSON.parse(readFileSync(join(f.directory, run.id, 'command.json'), 'utf8'));
  assert.equal(readFileSync(spec.argv[1], 'utf8'), 'console.log("before")');
  assert.equal((await f.action({ action: 'status', id: run.id })).status, 'prepared');
  assert.equal(f.notices.length, 0);
});
test('decline, cancellation and authorization changes never prepare a launch', async () => {
  const f = setup();
  assert.deepEqual(await f.action(f.request, async r => r.deny), { status: 'declined' });
  await assert.rejects(f.action(f.request, async () => { throw new Error('delivery failed'); }), /delivery failed/);
  await assert.rejects(f.action(f.request, approve, target, async () => { throw new Error('revoked'); }), /revoked/);
  assert.deepEqual(await f.action({ action: 'list' }), []);
  assert.equal(readdirSync(f.directory).length, 0);
});
test('strict input and real paths prevent out-of-workspace staging', async () => {
  const f = setup(), outside = mkdtempSync(join(tmpdir(), 'outside-'));
  for (const change of [{ cwd: outside }, { argv: ['node'] }, { argv: [] }, { snapshot_args: [9] },
    { timeout_seconds: 0 }, { env: { X: 1 } }, { unknown: true }]) {
    await assert.rejects(f.action({ ...f.request, ...change }));
  }
});
test('runs remain scoped to room, sender and session; stop is only a request', async () => {
  const f = setup(), run = await f.action(f.request);
  for (const t of [{ ...target, room: '!other:example.com' }, { ...target, session: 'other' }, { ...target, sender: '@bob:example.com' }]) {
    assert.deepEqual(await f.action({ action: 'list' }, approve, t), []);
    await assert.rejects(f.action({ action: 'stop', id: run.id }, approve, t), /not found/);
  }
  const stopped = await f.action({ action: 'stop', id: run.id });
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.stop_requested, true);
});
test('recovery detects reused PID and retains capacity for uncertain descendants', async () => {
  const f = setup(), run = await f.action(f.request);
  const identity = { pid: 123, ppid: 1, pgid: 123, birth: 'old' };
  save(join(f.directory, run.id, 'status.json'), { id: run.id, status: 'running', supervisor: identity, updated_at: new Date().toISOString() });
  f.hooks.processTable = () => [{ ...identity, birth: 'new' }];
  const recovered = new DetachedRuns(f.directory, f.workspace, f.hooks);
  recovered.pump(() => true);
  assert.equal(f.notices.length, 1); assert.match(f.notices[0][2], /pid_reused/);
  recovered.pump(() => true); assert.equal(f.notices.length, 1);
  const second = await recovered.action(f.request, target, signal, approve, async () => {});
  assert.equal(JSON.parse(second).status, 'prepared');
  await assert.rejects(recovered.action(f.request, target, signal, approve, async () => {}), /already active or uncertain/);
  save(join(f.directory, run.id, 'status.json'), { id: run.id, status: 'succeeded', exit_code: 0 });
  recovered.pump(() => true); assert.equal(f.notices.length, 2); assert.match(f.notices[1][0], /succeeded/);
  new DetachedRuns(f.directory, f.workspace, f.hooks).pump(() => true); assert.equal(f.notices.length, 2);
});
test('notification admission failure is retried; a reset revokes unlaunched runs', async () => {
  const f = setup(), run = await f.action(f.request);
  save(join(f.directory, run.id, 'status.json'), { id: run.id, status: 'failed', exit_code: 7 });
  let fail = true;
  f.hooks.notify = (...args) => { if (fail) throw new Error('queue full'); f.notices.push(args); };
  assert.throws(() => f.manager.pump(() => true), /queue full/);
  fail = false; f.manager.pump(() => true); assert.equal(f.notices.length, 1);
  const next = await f.action(f.request);
  f.manager.pump(() => false);
  assert.equal((await f.action({ action: 'status', id: next.id })).status, 'stopped');
});
test('deadlines, stale heartbeat and process-table errors never claim successful termination', async () => {
  const f = setup(), run = await f.action(f.request);
  const indexFile = join(f.directory, 'index.json');
  const index = JSON.parse(readFileSync(indexFile, 'utf8')); index.runs[0].launchBy = Date.now() - 1;
  save(indexFile, index);
  const expired = new DetachedRuns(f.directory, f.workspace, f.hooks);
  const read = () => expired.action({ action: 'status', id: run.id }, target, signal, approve, async () => {}).then(JSON.parse);
  assert.equal((await read()).status, 'stopped');
  writeFileSync(join(f.directory, run.id, 'claimed'), '');
  assert.equal((await read()).status, 'lost');
  const identity = { pid: 123, ppid: 1, pgid: 123, birth: 'fixture' };
  f.hooks.processTable = () => [identity];
  save(join(f.directory, run.id, 'status.json'), { id: run.id, status: 'running', supervisor: identity, updated_at: 'invalid' });
  assert.equal((await read()).reason, 'heartbeat_stale');
  f.hooks.processTable = () => { throw new Error('EPERM'); };
  assert.equal((await read()).reason, 'process_observation_unavailable');
});
test('log control bytes cannot prevent durable completion notification', async () => {
  const f = setup(), run = await f.action(f.request);
  save(join(f.directory, run.id, 'status.json'), { id: run.id, status: 'succeeded', exit_code: 0 });
  writeFileSync(join(f.directory, run.id, 'output.log'), '\x1b[31mhello\0\n');
  f.manager.pump(() => true);
  assert.equal(f.notices.length, 1);
  assert.ok(!/[\x00-\x08\x0b-\x1f]/.test(f.notices[0][2]));
});

test('observation failures retain safe diagnostics through status and completion notification', async () => {
  const f = setup(), run = await f.action(f.request);
  save(join(f.directory, run.id, 'status.json'), { id: run.id, status: 'running',
    supervisor: { pid: 123, ppid: 1, pgid: 123, birth: 'fixture' }, updated_at: new Date().toISOString() });
  f.hooks.processTable = () => { throw Object.assign(new Error('private command and token'), { code: 'EPERM' }); };
  const status = await f.action({ action: 'status', id: run.id });
  assert.equal(status.status, 'lost');
  assert.deepEqual(status.diagnostic, { stage: 'inspect_process_table', type: 'Error', code: 'EPERM' });
  f.manager.pump(() => true);
  assert.match(JSON.stringify(f.notices), /inspect_process_table.*EPERM/);
  assert.doesNotMatch(JSON.stringify(f.notices), /private command|token/);
  writeFileSync(join(f.directory, run.id, 'status.json'), '{private secret');
  assert.equal((await f.action({ action: 'status', id: run.id })).diagnostic.type, 'SyntaxError');
});
