import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { superviseCommand, type ProcessRow } from '../scripts/detached-runner.mjs';

for (const survivor of [false, true]) test(`reaped root in a delayed snapshot: surviving descendant=${survivor}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-exit-race-'));
  const child = spawn(process.execPath, ['-e',
    'process.on("SIGTERM",()=>process.exit(0)); console.log("ready"); setInterval(()=>{},1000)'],
  { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = once(child.stdout, 'data');
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
  const state: Record<string, any> = { status: 'starting', reason: null, updated_at: new Date().toISOString() };
  // Synthetic descendant rows must never signal real processes.
  const signals: number[] = [];
  t.mock.method(process, 'kill', (pid: number) => { signals.push(pid); return true; });
  let reads = 0;
  await superviseCommand(child, { pause: 1, readAsync: async () => {
    if (++reads !== 1) return [];
    await ready;
    const snapshot: ProcessRow[] = [{ pid: child.pid!, ppid: process.pid, pgid: child.pid!, state: 'S', birth: 'test birth' }];
    if (survivor) snapshot.push({ pid: 99999999, ppid: child.pid!, pgid: child.pid!, state: 'S', birth: 'descendant birth' });
    // The table helper has captured the live root, but delivers that snapshot
    // only after the parent's exit listener has reaped it. No scheduler race.
    child.kill('SIGTERM');
    await exited;
    return snapshot;
  } }, { timeout_seconds: 10, max_log_bytes: 4096 }, dir, state, () => {});
  assert.equal(state.exit_code, 0);
  assert.equal(state.reason, survivor ? 'descendants_after_exit' : null);
  assert.equal(state.status, survivor ? 'failed' : 'succeeded');
  if (!survivor) assert.deepEqual(signals, []);
});
