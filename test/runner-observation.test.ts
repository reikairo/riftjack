import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { superviseCommand, type ProcessRow } from '../scripts/detached-runner.mjs';

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const timeout = () => Object.assign(new Error('untrusted command output'), { code: 'ETIMEDOUT' });
async function until(check: () => boolean) {
  const end = Date.now() + 12000;
  while (!check()) { assert.ok(Date.now() < end, 'fixture deadline'); await wait(25); }
}
function fixture(t: any, code: string) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-observation-'));
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
  let exited = false;
  child.once('exit', () => { exited = true; });
  const identity: ProcessRow = { pid: child.pid!, ppid: process.pid, pgid: child.pid!, state: 'S', birth: 'fixture birth' };
  const rows = () => exited ? [] : [identity];
  const state: any = { status: 'starting', child: null, descendants: [], reason: null, exit_code: null, updated_at: new Date().toISOString() };
  const states: any[] = [];
  const persist = () => { state.updated_at = new Date().toISOString(); states.push(structuredClone(state)); };
  const log = () => { try { return readFileSync(join(dir, 'output.log'), 'utf8'); } catch { return ''; } };
  const run = (readAsync: () => Promise<ProcessRow[]>) => superviseCommand(child, { readAsync, pause: 20 },
    { max_log_bytes: 65536, timeout_seconds: 30 }, dir, state, persist);
  return { dir, child, identity, rows, state, states, log, run };
}

test('two temporary observation failures recover without losing output or claiming a lost run', async t => {
  const f = fixture(t, 'console.log("before"); setTimeout(()=>console.error("after"),300)');
  let reads = 0;
  await f.run(async () => { if (++reads <= 2) throw timeout(); return f.rows(); });
  assert.equal(reads, 3);
  assert.equal(f.state.status, 'succeeded');
  assert.ok(f.states.some(s => s.observation?.state === 'retrying'));
  assert.ok(f.states.every(s => s.status !== 'lost'));
  assert.match(f.log(), /before[\s\S]*after/);
  assert.equal(f.state.diagnostic, undefined);
});

test('output drains and flushes while an asynchronous table read is still pending', async t => {
  const f = fixture(t, 'setTimeout(()=>process.stdout.write("x".repeat(300000),()=>console.log("tail")),100)');
  let release!: () => void;
  const pending = new Promise<void>(r => { release = r; });
  const done = f.run(async () => { await pending; return f.rows(); });
  try {
    await until(() => f.log().includes('tail'));
    assert.equal(f.state.status, 'starting'); // observation is still awaiting its result
    assert.ok(Buffer.byteLength(f.log()) <= 65536);
    assert.equal(f.state.log_truncated, true);
  } finally { release(); await done; }
  assert.equal(f.state.status, 'succeeded');
});

test('persistent observation loss keeps old identities unknown and collects output after lost', async t => {
  const f = fixture(t, 'console.log("early"); setTimeout(()=>console.log("late output after lost"),4000)');
  let reads = 0;
  const done = f.run(async () => { if (++reads === 1) return f.rows(); throw timeout(); });
  await until(() => f.state.status === 'lost');
  assert.equal(f.state.finished_at, undefined);
  assert.equal(f.state.reason, 'process_observation_failed');
  assert.deepEqual(f.state.descendants, [f.identity]); // stale, not an empty successful snapshot
  await done;
  assert.match(f.log(), /late output after lost/);
  assert.equal(f.state.status, 'lost');
  assert.equal(f.state.exit_code, 0); // a reaped root is not proof that descendants ended
  assert.ok(f.state.finished_at);
  assert.doesNotMatch(JSON.stringify(f.states), /untrusted command output/);
});

test('stop during a retry waits for fresh identities before signalling the child', async t => {
  const f = fixture(t, 'console.log("started"); setInterval(()=>{},1000)');
  let reads = 0;
  await f.run(async () => {
    if (++reads === 2) { writeFileSync(join(f.dir, 'stop'), ''); throw timeout(); }
    return f.rows();
  });
  assert.equal(f.state.status, 'stopped');
  assert.equal(f.state.reason, 'stop_requested');
  assert.match(f.log(), /started/);
  assert.ok(f.child.signalCode);
});

test('a later healthy snapshot cannot clear lost after the retry budget was exhausted', async t => {
  const f = fixture(t, 'setTimeout(()=>console.log("finished"),3000)');
  let reads = 0;
  await f.run(async () => { if (++reads <= 3) throw timeout(); return f.rows(); });
  assert.equal(f.state.observation.state, 'available');
  assert.equal(f.state.status, 'lost');
  assert.equal(f.state.output_capture, 'closed');
  assert.match(f.log(), /finished/);
});

test('recovery never signals a PID whose birth changed during the observation gap', async t => {
  const f = fixture(t, 'setTimeout(()=>console.log("natural exit"),2500)');
  const signals: number[] = [];
  t.mock.method(process, 'kill', (pid: number) => { signals.push(pid); return true; });
  let reads = 0;
  await f.run(async () => {
    if (++reads === 1) return f.rows();
    if (reads === 2) { writeFileSync(join(f.dir, 'stop'), ''); throw timeout(); }
    return f.rows().map(p => ({ ...p, birth: 'replacement birth' }));
  });
  assert.deepEqual(signals, []);
  assert.match(f.log(), /natural exit/);
});
