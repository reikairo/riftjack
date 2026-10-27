import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DetachedRuns } from '../src/detached-runs.js';
import { processes } from '../scripts/detached-runner.mjs';

const target = { key: 'k', room: '!test:example.com', sender: '@alice:example.com', session: 's' };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined, timeout = 12000): Promise<T> {
  const end = Date.now() + timeout;
  do { const value = fn(); if (value) return value; await wait(100); } while (Date.now() < end);
  throw new Error('Fixture did not reach expected state');
}
function canObserve() { try { processes(); return true; } catch { return false; } }
async function fixture(code: string, timeout = 10) {
  const workspace = mkdtempSync(join(tmpdir(), 'detached-runner-'));
  const directory = join(workspace, 'runs');
  const manager = new DetachedRuns(directory, workspace, { notify() {} });
  const run = JSON.parse(await manager.action({ action: 'start', label: 'process fixture', cwd: workspace,
    argv: [process.execPath, '-e', code], timeout_seconds: timeout }, target, new AbortController().signal, async r => r.approve!, async () => {}));
  const dir = join(directory, run.id);
  const status = () => { try { return JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')); } catch { return undefined; } };
  const launch = () => execFileSync(run.launch_argv[0], run.launch_argv.slice(1), { encoding: 'utf8', timeout: 4000 });
  const stop = async () => {
    writeFileSync(join(dir, 'stop'), '');
    await until(() => { const s = status(); return s && ['succeeded','failed','stopped','lost'].includes(s.status) ? s : undefined; });
  };
  return { workspace, dir, run, manager, status, launch, stop };
}
test('detached command survives launch-parent termination and observer reconstruction', async t => {
  if (!canObserve()) return t.skip('OS process table denied in this sandbox; run this process test with one-time approval.');
  const f = await fixture('console.log("started"); setTimeout(() => console.log("finished"), 1500)');
  t.after(f.stop);
  const parent = spawn(process.execPath, ['-e', `const {spawnSync}=require('node:child_process'); spawnSync(${JSON.stringify(f.run.launch_argv[0])},${JSON.stringify(f.run.launch_argv.slice(1))}); setInterval(()=>{},1000);`], { stdio: 'ignore' });
  t.after(() => { parent.kill('SIGKILL'); });
  await until(() => f.status()?.status === 'running'); parent.kill('SIGKILL');
  const notices: any[] = [];
  const observer = new DetachedRuns(join(f.workspace, 'runs'), f.workspace, { notify: (...args) => { notices.push(args); } });
  const final = await until(() => f.status()?.status === 'succeeded' && f.status());
  assert.equal(final.exit_code, 0);
  observer.pump(() => true); observer.pump(() => true); assert.equal(notices.length, 1);
  assert.match(notices[0][2], /finished/);
  assert.throws(f.launch); // permanent launch claim prevents a second execution
});
test('runtime bounds output and timeout stops a live command', async t => {
  if (!canObserve()) return t.skip('OS process table denied; process tests need one-time approval.');
  const f = await fixture('process.stdout.write("x".repeat(1500000)); setInterval(()=>{},1000)', 1);
  t.after(f.stop); f.launch();
  const final = await until(() => f.status()?.status === 'failed' && f.status());
  assert.equal(final.reason, 'timeout'); assert.equal(final.log_truncated, true);
  assert.ok(statSync(join(f.dir, 'output.log')).size <= 1024 * 1024);
});
test('stop reaches a tracked child that started its own process group', async t => {
  if (!canObserve()) return t.skip('OS process table denied; process tests need one-time approval.');
  const f = await fixture(`const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    fs.writeFileSync('escaped.pid',String(c.pid)); setInterval(()=>{},1000);`);
  t.after(f.stop); f.launch();
  await until(() => existsSync(join(f.workspace, 'escaped.pid')));
  const pid = Number(readFileSync(join(f.workspace, 'escaped.pid'), 'utf8'));
  await until(() => f.status()?.descendants?.some((p: any) => p.pid === pid), 8000);
  await f.stop();
  assert.equal(f.status().status, 'stopped');
  assert.ok(!processes().some(p => p.pid === pid));
});
test('changed specification is refused without executing the command', async t => {
  const f = await fixture('require("node:fs").writeFileSync("executed", "yes")');
  writeFileSync(join(f.dir, 'command.json'), '{}');
  assert.throws(f.launch, /specification changed/);
  assert.equal(existsSync(join(f.workspace, 'executed')), false);
});
test('unavailable process observation fails closed before executing the command', async t => {
  if (canObserve()) return t.skip('This case exercises the restricted process-table environment.');
  const f = await fixture('require("node:fs").writeFileSync("executed", "yes")');
  f.launch();
  const final = await until(() => f.status()?.status === 'lost' && f.status());
  assert.equal(final.reason, 'supervisor_failed');
  assert.equal(existsSync(join(f.workspace, 'executed')), false);
});
