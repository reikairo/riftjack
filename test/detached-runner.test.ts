import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { DetachedRuns } from '../src/detached-runs.js';
import { processes, selectProcessTable } from '../scripts/detached-runner.mjs';

const target = { key: 'k', room: '!test:example.com', sender: '@alice:example.com', session: 's' };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined, timeout = 12000): Promise<T> {
  const end = Date.now() + timeout;
  do { const value = fn(); if (value) return value; await wait(100); } while (Date.now() < end);
  throw new Error('Fixture did not reach expected state');
}
// Strict runs require every process table source available on this platform instead of skipping when one is refused.
const strict = process.env.RIFTJACK_TEST_REQUIRE_PROCESS_TABLES === '1';
// Only an environment refusing a process table (EPERM) skips a test; any other error fails it.
function refused(error: any) {
  if (error?.code !== 'EPERM' || strict) throw error;
  return true;
}
function canObserve() { try { processes(); return true; } catch (error) { return !refused(error); } }
function sysctlAvailable() { try { selectProcessTable('sysctl'); return true; } catch (error) { return !refused(error); } }
function psRefused() { try { selectProcessTable('ps'); return false; } catch (error: any) { return error?.code === 'EPERM'; } }
// Launched supervisors inherit this environment and read only the forced source.
function forceSource(t: { after(fn: () => void): void }, source: string) {
  const previous = process.env.RIFTJACK_TEST_PROCESS_TABLE;
  process.env.RIFTJACK_TEST_PROCESS_TABLE = source;
  t.after(() => { if (previous === undefined) delete process.env.RIFTJACK_TEST_PROCESS_TABLE; else process.env.RIFTJACK_TEST_PROCESS_TABLE = previous; });
}
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
async function terminal(f: Awaited<ReturnType<typeof fixture>>) {
  try {
    return await until(() => { const s = f.status(); return s?.finished_at ? s : undefined; });
  } catch (error) {
    let output = '';
    try { output = readFileSync(join(f.dir, 'output.log'), 'utf8').slice(-4096); } catch { /* Launch may have failed before output. */ }
    throw new Error(`Runner did not finish. Last status: ${JSON.stringify(f.status())}; output: ${output}`, { cause: error });
  }
}
test('detached command survives launch-parent termination and observer reconstruction', async t => {
  if (!canObserve()) return t.skip('This environment refuses ps and kern.proc.all; run this process test with one-time approval.');
  const f = await fixture('const fs=require("node:fs"); console.log("started"); const tick=setInterval(()=>{if(fs.existsSync("finish")){clearInterval(tick);console.log("finished");}},25)', 30);
  t.after(f.stop);
  const parent = spawn(process.execPath, ['-e', `const {spawnSync}=require('node:child_process'); spawnSync(${JSON.stringify(f.run.launch_argv[0])},${JSON.stringify(f.run.launch_argv.slice(1))}); setInterval(()=>{},1000);`], { stdio: 'ignore' });
  t.after(() => { parent.kill('SIGKILL'); });
  const parentExited = once(parent, 'exit');
  await until(() => f.status()?.status === 'running'); parent.kill('SIGKILL');
  await parentExited;
  // Keep the command alive until its launcher is gone; no fixed-duration race
  // against the process-table helper or the load of the surrounding test suite.
  writeFileSync(join(f.workspace, 'finish'), '');
  const notices: any[] = [];
  const observer = new DetachedRuns(join(f.workspace, 'runs'), f.workspace, { notify: (...args) => { notices.push(args); } });
  const final = await terminal(f);
  assert.equal(final.status, 'succeeded', JSON.stringify(final));
  assert.equal(final.exit_code, 0);
  observer.pump(() => true); observer.pump(() => true); assert.equal(notices.length, 1);
  assert.match(notices[0][2], /finished/);
  assert.throws(f.launch); // permanent launch claim prevents a second execution
});
test('runtime bounds output and timeout stops a live command', async t => {
  if (!canObserve()) return t.skip('This environment refuses the process table; process tests need one-time approval.');
  const f = await fixture('process.stdout.write("x".repeat(1500000)); setInterval(()=>{},1000)', 1);
  t.after(f.stop); f.launch();
  const final = await until(() => f.status()?.status === 'failed' && f.status());
  assert.equal(final.reason, 'timeout'); assert.equal(final.log_truncated, true);
  assert.ok(statSync(join(f.dir, 'output.log')).size <= 1024 * 1024);
});
const escapingChild = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    fs.writeFileSync('escaped.pid',String(c.pid)); setInterval(()=>{},1000);`;
async function stopsEscapedChild(f: Awaited<ReturnType<typeof fixture>>) {
  await until(() => existsSync(join(f.workspace, 'escaped.pid')));
  const pid = Number(readFileSync(join(f.workspace, 'escaped.pid'), 'utf8'));
  // A kern.proc.all read starts Python, which adds up to a second or more under load.
  await until(() => f.status()?.descendants?.some((p: any) => p.pid === pid), 20000);
  await f.stop();
  assert.equal(f.status().status, 'stopped');
  assert.ok(!processes().some(p => p.pid === pid));
}
test('stop reaches a tracked child that started its own process group', async t => {
  if (!canObserve()) return t.skip('This environment refuses the process table; process tests need one-time approval.');
  const f = await fixture(escapingChild);
  t.after(f.stop); f.launch();
  await stopsEscapedChild(f);
});
test('kern.proc.all observation tracks and stops a child that started its own process group', async t => {
  if (process.platform !== 'darwin') return t.skip('kern.proc.all is read only on macOS.');
  if (!sysctlAvailable()) return t.skip('This environment refuses the kern.proc.all sysctl.');
  forceSource(t, 'sysctl');
  const f = await fixture(escapingChild);
  t.after(f.stop); f.launch();
  await until(() => f.status()?.process_table);
  assert.deepEqual(f.status().process_table, { source: 'sysctl', pause_ms: 1000 });
  await stopsEscapedChild(f);
});
test('changed specification is refused without executing the command', async t => {
  const f = await fixture('require("node:fs").writeFileSync("executed", "yes")');
  writeFileSync(join(f.dir, 'command.json'), '{}');
  assert.throws(f.launch, /specification changed/);
  assert.equal(existsSync(join(f.workspace, 'executed')), false);
});
test('ordinary command approval can wait over an hour without losing the single-use launch', async t => {
  if (!canObserve()) return t.skip('This environment refuses the process table; process tests need one-time approval.');
  const prepared = Date.now() - 90 * 60_000;
  const clock = t.mock.method(Date, 'now', () => prepared);
  const f = await fixture('require("node:fs").appendFileSync("executed", "once\\n")');
  clock.mock.restore();
  t.after(f.stop);
  f.launch();
  await until(() => f.status()?.status === 'succeeded');
  assert.equal(readFileSync(join(f.workspace, 'executed'), 'utf8'), 'once\n');
  assert.throws(f.launch); // An already claimed launch cannot run twice.
});
test('expired and explicitly stopped launches never execute after a long wait', async t => {
  const prepared = Date.now() - 25 * 60 * 60_000;
  const clock = t.mock.method(Date, 'now', () => prepared);
  const expired = await fixture('require("node:fs").writeFileSync("executed", "yes")');
  clock.mock.restore();
  assert.throws(expired.launch, /expired or stopped/);
  assert.equal(existsSync(join(expired.dir, 'claimed')), false);
  assert.equal(existsSync(join(expired.workspace, 'executed')), false);
  const stopped = await fixture('require("node:fs").writeFileSync("executed", "yes")');
  writeFileSync(join(stopped.dir, 'stop'), '');
  assert.throws(stopped.launch, /expired or stopped/);
  assert.equal(existsSync(join(stopped.dir, 'claimed')), false);
  assert.equal(existsSync(join(stopped.workspace, 'executed')), false);
});
test('unavailable process observation fails closed before executing the command', async t => {
  if (!psRefused()) return t.skip('This case needs an environment that refuses /bin/ps.');
  forceSource(t, 'ps');
  const f = await fixture('require("node:fs").writeFileSync("executed", "yes")');
  f.launch();
  const final = await until(() => f.status()?.status === 'lost' && f.status());
  assert.equal(final.reason, 'supervisor_failed');
  assert.equal(final.diagnostic.stage, 'inspect_process_table');
  assert.equal(final.diagnostic.code, 'EPERM');
  assert.equal(existsSync(join(f.workspace, 'executed')), false);
});
