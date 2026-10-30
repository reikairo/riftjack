// Runs only when invoked by the agent's ordinary command tool. The connector
// never executes this file: the launcher inherits that tool's OS sandbox.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file is copied by itself into each approved run. Keep diagnostics self-contained and
// allowlisted: subprocess errors can contain the complete command, environment or output.
class RunnerError extends Error {}
export function failureDetails(error, stage) {
  const codes = new Set(['EPERM', 'EACCES', 'ENOENT', 'ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE', 'EIO', 'EROFS', 'EEXIST', 'ESRCH', 'EINVAL', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ETIMEDOUT']);
  const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError']);
  const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGBUS']);
  return { stage, ...(error instanceof RunnerError && { message: error.message }), ...(names.has(error?.name) && { type: error.name }),
    ...(codes.has(error?.code) && { code: error.code }),
    ...(Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255 && { exit_code: error.code }),
    ...(signals.has(error?.signal) && { signal: error.signal }),
    ...(error?.killed === true && { killed: true }) };
}
// The data handlers only update bounded memory. The observation loop flushes at
// most once per tick, and completion flushes once more before reporting success.
export class BoundedOutput {
  constructor(path, limit) { this.path = path; this.limit = limit; this.bytes = Buffer.alloc(0); this.dirty = false; this.truncated = false; }
  append(chunk) {
    if (this.bytes.length + chunk.length > this.limit) this.truncated = true;
    this.bytes = Buffer.concat([this.bytes, chunk.subarray(-this.limit)]).subarray(-this.limit);
    this.dirty = true;
  }
  flush() {
    if (!this.dirty) return;
    writeFileSync(this.path + '.tmp', this.bytes, { mode: 0o600 });
    renameSync(this.path + '.tmp', this.path);
    this.dirty = false;
  }
}
let phase = 'validate_launch';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function save(path, value) {
  const fd = openSync(path + '.tmp', 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(path + '.tmp', path);
}
export function processes() {
  // No argv or environment is collected. lstart is a birth identity, not elapsed
  // runtime; an unreadable process table is uncertainty, never proof of death.
  const text = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  });
  return text.split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    return m ? [{ pid: +m[1], ppid: +m[2], pgid: +m[3], state: m[4], birth: m[5] }] : [];
  });
}
export const same = (a, b) => !!a && !!b && a.pid === b.pid && a.birth === b.birth;

async function main() {
  process.umask(0o077);
  const [dir, hash, mode] = process.argv.slice(2);
  if (!dir || !/^[a-f0-9]{64}$/.test(hash ?? '')) throw new RunnerError('Use the exact launch argv returned by run_detached.');
  const bytes = readFileSync(join(dir, 'command.json'));
  if (digest(bytes) !== hash) throw new RunnerError('Run specification changed; prepare a new run.');
  const spec = JSON.parse(bytes);
  if (digest(readFileSync(fileURLToPath(import.meta.url))) !== spec.launcher_sha256) throw new RunnerError('Launcher changed.');
  for (const file of spec.snapshots) if (digest(readFileSync(file.path)) !== file.sha256) throw new RunnerError('Script snapshot changed.');
  if (mode !== '--supervise') {
    if (Date.now() > spec.launch_by || existsSync(join(dir, 'stop'))) throw new RunnerError('Launch expired or stopped; prepare a new run.');
    // Never automatically retry an uncertain spawn: the claim is permanent.
    const claim = openSync(join(dir, 'claimed'), 'wx', 0o600); closeSync(claim);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), dir, hash, '--supervise'], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    await new Promise((yes, no) => { child.once('spawn', yes); child.once('error', no); });
    child.unref();
    console.log(JSON.stringify({ id: spec.id, status: 'starting', supervisor_pid: child.pid }));
    return;
  }
  // A copied supervisor cannot start the command twice either.
  phase = 'claim_supervisor';
  const lock = openSync(join(dir, 'supervised'), 'wx', 0o600); closeSync(lock);
  phase = 'inspect_process_table';
  let table = processes();
  const identity = table.find(p => p.pid === process.pid);
  if (!identity) throw new RunnerError('Cannot establish supervisor process identity.');
  const state = { id: spec.id, status: 'starting', supervisor: identity, started_at: new Date().toISOString(), updated_at: '',
    child: null, descendants: [], exit_code: null, signal: null, reason: null, log_truncated: false,
    containment: 'Observed descendants only; processes escaping between observations cannot be guaranteed stopped.' };
  const persist = () => { state.updated_at = new Date().toISOString(); save(join(dir, 'status.json'), state); };
  if (Date.now() > spec.launch_by || existsSync(join(dir, 'stop'))) { state.status = 'stopped'; persist(); return; }
  persist();
  // Secrets from the connector are never passed here. Keep only ordinary tool
  // environment names, then the explicitly reviewed overrides.
  const env = {};
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL']) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, spec.env);
  let stopping = 0, exited = false, spawnError = false, uncertain = false;
  const log = new BoundedOutput(join(dir, 'output.log'), spec.max_log_bytes);
  const observed = new Map();
  const output = chunk => { log.append(chunk); state.log_truncated = log.truncated; };
  phase = 'spawn_command';
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', output); child.stderr.on('data', output);
  child.once('error', error => { spawnError = true; state.reason = 'spawn_failed'; state.diagnostic = failureDetails(error, 'spawn_command'); exited = true; });
  child.once('exit', (code, signal) => { state.exit_code = code; state.signal = signal; exited = true; });
  const stop = reason => { if (!stopping) { stopping = Date.now(); state.reason = reason; } };
  process.on('SIGTERM', () => stop('stop_requested')); process.on('SIGINT', () => stop('stop_requested'));
  const started = Date.now();
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 200));
    try {
      log.flush();
      table = processes();
      const root = table.find(p => p.pid === child.pid);
      if (!state.child && root && root.ppid === process.pid) state.child = root;
      if (state.child) observed.set(state.child.pid, state.child);
      // Retain escaped, subsequently reparented descendants once observed.
      let added;
      do {
        added = false;
        for (const p of table) if (!observed.has(p.pid) && table.some(parent => parent.pid === p.ppid && same(parent, observed.get(parent.pid)))) {
          observed.set(p.pid, p); added = true;
        }
      } while (added);
      const alive = table.filter(p => !p.state.startsWith('Z') && same(p, observed.get(p.pid)));
      state.descendants = alive.slice(0, 256);
      if (alive.length > 256) { uncertain = true; stop('descendant_tracking_limit'); }
      if (existsSync(join(dir, 'stop'))) stop('stop_requested');
      if (Date.now() - started >= spec.timeout_seconds * 1000) stop('timeout');
      if (exited && alive.length) stop('descendants_after_exit');
      if (stopping) {
        const signal = Date.now() - stopping >= 2000 ? 'SIGKILL' : 'SIGTERM';
        // Never signal a reused PID, or a process group whose leader identity
        // cannot be checked. Escaped observed descendants are signalled singly.
        const leader = processes().find(p => p.pid === state.child?.pid);
        if (same(leader, state.child) && leader.pgid === leader.pid) {
          try { process.kill(-leader.pgid, signal); } catch (error) { state.diagnostic = failureDetails(error, 'signal_process_group'); /* individual identity checks below */ }
        }
        for (const p of alive) {
          try {
            const current = processes().find(x => x.pid === p.pid);
            if (same(current, p)) process.kill(p.pid, signal);
          } catch (error) { if (error.code !== 'ESRCH') { uncertain = true; state.diagnostic = failureDetails(error, 'signal_descendant'); } }
        }
      }
      if (exited && !alive.length) break;
      if (stopping && Date.now() - stopping > 10_000) { uncertain = true; break; }
      const next = stopping ? 'stopping' : 'running';
      const changed = state.status !== next;
      state.status = next;
      if (changed || Date.now() - Date.parse(state.updated_at) >= 5000) persist();
    } catch (error) {
      state.diagnostic = failureDetails(error, 'observe_running_command');
      // Failure to observe cannot justify sending signals to old identities.
      uncertain = true; state.reason = 'process_observation_failed'; break;
    }
  }
  try { log.flush(); } catch (error) { uncertain = true; state.reason = 'log_write_failed'; state.diagnostic = failureDetails(error, 'write_output_log'); }
  state.status = uncertain ? 'lost' : state.reason === 'stop_requested' ? 'stopped'
    : spawnError || state.exit_code !== 0 || state.reason === 'timeout' || state.reason === 'descendants_after_exit' ? 'failed' : 'succeeded';
  state.finished_at = new Date().toISOString(); persist();
  // A lost supervisor must not wait forever on inherited output pipes.
  child.stdout.destroy(); child.stderr.destroy(); child.unref();
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main().catch(error => {
  if (process.argv[4] === '--supervise') {
    try {
      const path = join(process.argv[2], 'status.json');
      const state = JSON.parse(readFileSync(path, 'utf8'));
      save(path, { ...state, status: 'lost', reason: 'supervisor_failed', diagnostic: failureDetails(error, phase), updated_at: new Date().toISOString() });
    } catch { /* the observer also treats missing or invalid status as lost */ }
  }
  console.error(JSON.stringify(failureDetails(error, phase))); process.exitCode = 1;
});
