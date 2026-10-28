import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
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

async function lostRun(f: ReturnType<typeof setup>) {
  const run = await f.action(f.request);
  const index = JSON.parse(readFileSync(join(f.directory, 'index.json'), 'utf8'));
  index.runs.find((r: any) => r.id === run.id).launchBy = Date.now() - 1;
  save(join(f.directory, 'index.json'), index);
  save(join(f.directory, run.id, 'status.json'), { id: run.id, status: 'lost', reason: 'supervisor_failed',
    supervisor: { pid: 123, ppid: 1, pgid: 123, birth: 'old' },
    child: { pid: 124, ppid: 123, pgid: 124, birth: 'old-child' },
    descendants: [{ pid: 125, ppid: 1, pgid: 125, birth: 'escaped' }] });
  return run;
}
const evidence = 'Checked the full process table at 12:00 UTC; recorded groups and escaped descendants are absent.';
test('closing lost runs retains forensic files, releases capacity and survives restart', async () => {
  const f = setup(), first = await lostRun(f);
  const manager = new DetachedRuns(f.directory, f.workspace, f.hooks);
  const act = (input: unknown, interact = approve) => manager.action(input, target, signal, interact, async () => {}).then(JSON.parse);
  await act(f.request);
  await assert.rejects(act(f.request), /already active/);
  const statusPath = join(f.directory, first.id, 'status.json'), original = readFileSync(statusPath, 'utf8');
  writeFileSync(join(f.directory, first.id, 'output.log'), 'original output');
  const closed = await act({ action: 'close', id: first.id, evidence });
  assert.equal(closed.status, 'lost'); assert.equal(closed.closed.evidence, evidence);
  assert.equal(readFileSync(statusPath, 'utf8'), original);
  assert.equal(readFileSync(join(f.directory, first.id, 'output.log'), 'utf8'), 'original output');
  assert.ok(!readdirSync(join(f.directory, first.id)).includes('stop'));
  const repeat = await act({ action: 'close', id: first.id, evidence }, async () => { throw Error('Unexpected repeat confirmation'); });
  assert.deepEqual(repeat.closed, closed.closed);
  const recovered = new DetachedRuns(f.directory, f.workspace, f.hooks);
  const list = JSON.parse(await recovered.action({ action: 'list' }, target, signal, approve, async () => {}));
  assert.deepEqual(list[0].closed, closed.closed);
  assert.equal(JSON.parse(await recovered.action(f.request, target, signal, approve, async () => {})).status, 'prepared');
});
test('closure rejects live supervisors, children, escaped descendants and remaining groups', async () => {
  const f = setup(), run = await lostRun(f), manager = new DetachedRuns(f.directory, f.workspace, f.hooks);
  for (const process of [
    { pid: 123, pgid: 999, birth: 'old' }, { pid: 124, pgid: 999, birth: 'old-child' },
    { pid: 125, pgid: 999, birth: 'escaped' }, { pid: 900, pgid: 124, birth: 'other' },
  ]) {
    f.hooks.processTable = () => [process];
    await assert.rejects(manager.action({ action: 'close', id: run.id, evidence }, target, signal, approve, async () => {}), /still present/);
  }
  f.hooks.processTable = () => [{ pid: 123, pgid: 999, birth: 'reused' }];
  const result = JSON.parse(await manager.action({ action: 'close', id: run.id, evidence }, target, signal, approve, async () => {}));
  assert.equal(result.status, 'lost'); assert.ok(result.closed);
});
test('closure rechecks after confirmation, requires readable process table and preserves refusal', async () => {
  const f = setup(), run = await lostRun(f), manager = new DetachedRuns(f.directory, f.workspace, f.hooks);
  const request = { action: 'close', id: run.id, evidence };
  const act = (interact = approve, auth = async () => {}) => manager.action(request, target, signal, interact, auth).then(JSON.parse);
  assert.deepEqual(await act(async r => r.deny), { status: 'declined' });
  await assert.rejects(act(async () => { throw Error('delivery failed'); }), /delivery failed/);
  await assert.rejects(act(approve, async () => { throw Error('revoked'); }), /revoked/);
  await assert.rejects(act(async r => {
    f.hooks.processTable = () => [{ pid: 125, pgid: 125, birth: 'escaped' }]; return r.approve!;
  }), /still present/);
  f.hooks.processTable = () => { throw Object.assign(new Error('private detail'), { code: 'EPERM' }); };
  await assert.rejects(act(), /Cannot verify processes/);
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'index.json'), 'utf8')).runs[0].closed, undefined);
});
test('closure requires evidence, scope, lost status and an expired launch window', async () => {
  const f = setup(), run = await f.action(f.request);
  await assert.rejects(f.action({ action: 'close', id: run.id, evidence }), /Only a lost/);
  save(join(f.directory, run.id, 'status.json'), { id: run.id, status: 'lost' });
  await assert.rejects(f.action({ action: 'close', id: run.id, evidence }), /launch window/);
  for (const value of [undefined, '', ' ', 'x'.repeat(2001)]) {
    await assert.rejects(f.action({ action: 'close', id: run.id, evidence: value }), /inspection|evidence/);
  }
  await assert.rejects(f.action({ action: 'close', id: run.id, evidence }, approve, { ...target, room: '!other:test' }), /not found/);
});

test('failed closure persistence does not release capacity in memory', async () => {
  const f = setup(), run = await lostRun(f);
  const manager = new DetachedRuns(f.directory, f.workspace, f.hooks);
  await manager.action(f.request, target, signal, approve, async () => {});
  mkdirSync(join(f.directory, 'index.json.tmp'));
  await assert.rejects(manager.action({ action: 'close', id: run.id, evidence }, target, signal, approve, async () => {}));
  const status = JSON.parse(await manager.action({ action: 'status', id: run.id }, target, signal, approve, async () => {}));
  assert.equal(status.closed, undefined);
  await assert.rejects(manager.action(f.request, target, signal, approve, async () => {}), /already active/);
});
test('restart context separates the saved status from a fresh process check, per conversation', async () => {
  const f = setup(), lost = await f.action(f.request), done = await f.action(f.request);
  const identity = { pid: 123, ppid: 1, pgid: 123, birth: 'fixture' };
  save(join(f.directory, lost.id, 'status.json'), { id: lost.id, status: 'running', supervisor: identity, updated_at: '2026-10-28T00:14:03Z' });
  writeFileSync(join(f.directory, lost.id, 'output.log'), 'building\n');
  save(join(f.directory, done.id, 'status.json'), { id: done.id, status: 'succeeded', exit_code: 0 });
  // After a restart the supervisor is gone: the record says running, the check says lost.
  const restarted = new DetachedRuns(f.directory, f.workspace, f.hooks), now = Date.parse('2026-10-28T00:30:00Z');
  assert.deepEqual(restarted.unfinished(target.key, target.session, now), [{ id: lost.id, label: 'fixture',
    saved: { status: 'running', updated_at: '2026-10-28T00:14:03Z' },
    observed: { checked_at: '2026-10-28T00:30:00.000Z', status: 'lost', reason: 'supervisor_missing_or_pid_reused' },
    log: join(f.directory, lost.id, 'output.log') }]);
  // Another conversation, or a reset session of this one, does not see the run.
  assert.deepEqual(restarted.unfinished('other-key', target.session), []);
  assert.deepEqual(restarted.unfinished(target.key, 'new-session'), []);
  // Listing only reads: nothing is notified, stopped or closed.
  assert.equal(f.notices.length, 0);
  assert.equal(readdirSync(join(f.directory, lost.id)).includes('stop'), false);
  assert.equal(restarted.unfinished(target.key, target.session).length, 1);
});
