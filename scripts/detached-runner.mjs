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
// No argv or environment is collected. lstart is a birth identity, not elapsed
// runtime; an unreadable process table is uncertainty, never proof of death.
const tableEnv = { PATH: '/usr/bin:/bin', LC_ALL: 'C' };
const tableRow = line => {
  const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
  return m ? [{ pid: +m[1], ppid: +m[2], pgid: +m[3], state: m[4], birth: m[5] }] : [];
};
function psTable() {
  const text = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024, env: tableEnv,
  });
  return text.split('\n').flatMap(tableRow);
}
// Claude Code's macOS sandbox refuses to execute the setuid /bin/ps, but its profile
// allows the kern.proc.all sysctl that ps itself reads. Node cannot call sysctl, so
// this helper prints the same columns, with lstart formatted as ps formats it, and
// refuses an unexpected kinfo_proc layout or state instead of guessing.
const sysctlHelper = String.raw`
import ctypes, os, struct, sys, time
def fail(reason):
    print('riftjack-process-table error: ' + reason)
    sys.exit(3)
SIZE = 648  # sizeof(struct kinfo_proc) on 64-bit macOS
libc = ctypes.CDLL(None, use_errno=True)
mib = (ctypes.c_int * 3)(1, 14, 0)  # CTL_KERN, KERN_PROC, KERN_PROC_ALL
for attempt in range(5):
    size = ctypes.c_size_t(0)
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0):
        fail('size_errno_%d' % ctypes.get_errno())
    size.value += size.value // 4 + 16 * SIZE
    data = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, data, ctypes.byref(size), None, 0) == 0:
        break
    if ctypes.get_errno() != 12:  # ENOMEM: the table grew between the two calls
        fail('read_errno_%d' % ctypes.get_errno())
else:
    fail('table_kept_growing')
raw = data.raw[:size.value]
if not raw or len(raw) % SIZE:
    fail('unexpected_record_size')
states = {1: 'I', 2: 'R', 3: 'S', 4: 'T', 5: 'Z'}  # SIDL, SRUN, SSLEEP, SSTOP, SZOMB
rows, me = [], None
for offset in range(0, len(raw), SIZE):
    started, = struct.unpack_from('=q', raw, offset)  # kp_proc.p_starttime.tv_sec
    state = states.get(raw[offset + 36])  # kp_proc.p_stat
    pid, = struct.unpack_from('=i', raw, offset + 40)  # kp_proc.p_pid
    ppid, pgid = struct.unpack_from('=ii', raw, offset + 560)  # kp_eproc.e_ppid, e_pgid
    if state is None:
        fail('unexpected_state')
    rows.append('%d %d %d %s %s' % (pid, ppid, pgid, state, time.strftime('%a %b %e %H:%M:%S %Y', time.localtime(started))))
    if pid == os.getpid():
        me = (ppid, pgid)
if me != (os.getppid(), os.getpgrp()):
    fail('unexpected_layout')
print('riftjack-process-table %d' % len(rows))
for row in rows:
    print(row)
print('end')
`;
// The header count and the end marker reject truncated or partial output.
export function parseSysctlTable(text) {
  const lines = text.split('\n');
  const count = Number(/^riftjack-process-table (\d+)$/.exec(lines[0])?.[1]);
  const table = lines.slice(1, -2).flatMap(tableRow);
  if (!Number.isInteger(count) || table.length !== count || lines.length !== count + 3 || lines.at(-2) !== 'end' || lines.at(-1) !== '') {
    throw new RunnerError('The kern.proc.all process table was incomplete.');
  }
  return table;
}
export function sysctlTable(python) {
  let text;
  try {
    text = execFileSync(python, ['-I', '-S', '-c', sysctlHelper], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, env: tableEnv });
  } catch (error) {
    const refused = /^riftjack-process-table error: ([a-z0-9_]+)$/m.exec(String(error?.stdout ?? ''))?.[1];
    if (refused) throw new RunnerError(`The kern.proc.all process table was refused: ${refused}.`);
    if (Number.isInteger(error?.status)) throw new RunnerError(`The kern.proc.all helper exited with status ${error.status}.`);
    throw error;
  }
  return parseSysctlTable(text);
}
// /usr/bin/python3 is an xcrun shim that adds about 0.1 s to every start, so the
// interpreter it resolves is reused for later reads.
export function resolvePython(launcher = '/usr/bin/python3') {
  let path = '';
  try { path = execFileSync(launcher, ['-I', '-S', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 15_000, env: tableEnv }).trim(); }
  catch { /* Reported below without subprocess output. */ }
  if (!path.startsWith('/') || !existsSync(path)) {
    throw new RunnerError(`Reading the process table without /bin/ps needs Python 3 at ${launcher}; install the Xcode Command Line Tools with xcode-select --install.`);
  }
  return path;
}
// Every identity of a run must come from one source, and a later read error stays
// an error rather than switching sources. Both sources format births identically,
// so the connector's ps reads still match a sandboxed supervisor's records.
export function selectProcessTable(forced) {
  if (forced && forced !== 'ps' && forced !== 'sysctl') throw new RunnerError('RIFTJACK_TEST_PROCESS_TABLE must be ps or sysctl.');
  if (forced !== 'sysctl') {
    try { psTable(); return { source: 'ps', read: psTable, interval: 200 }; }
    catch (error) { if (forced === 'ps' || process.platform !== 'darwin' || error?.code !== 'EPERM') throw error; }
  }
  if (process.platform !== 'darwin') throw new RunnerError('The kern.proc.all process table is read only on macOS.');
  const python = resolvePython();
  const read = () => sysctlTable(python);
  read();
  // Each read starts Python, so the supervisor observes once a second instead.
  return { source: 'sysctl', read, interval: 1000 };
}
let selected;
export const processTable = () => selected ??= selectProcessTable(process.env.RIFTJACK_TEST_PROCESS_TABLE);
export const processes = () => processTable().read();
export const same = (a, b) => !!a && !!b && a.pid === b.pid && a.birth === b.birth;
// Retain escaped, subsequently reparented descendants once observed: adds every
// process whose parent identity is observed, then returns the observed processes
// alive in this table. A reused PID has another birth, so it is neither alive nor
// a parent of tracked processes.
export function track(table, observed) {
  let added;
  do {
    added = false;
    for (const p of table) if (!observed.has(p.pid) && table.some(parent => parent.pid === p.ppid && same(parent, observed.get(parent.pid)))) {
      observed.set(p.pid, p); added = true;
    }
  } while (added);
  return table.filter(p => !p.state.startsWith('Z') && same(p, observed.get(p.pid)));
}

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
  const observer = processTable();
  let table = observer.read();
  const identity = table.find(p => p.pid === process.pid);
  if (!identity) throw new RunnerError('Cannot establish supervisor process identity.');
  const state = { id: spec.id, status: 'starting', supervisor: identity, started_at: new Date().toISOString(), updated_at: '',
    process_table: { source: observer.source, interval_ms: observer.interval },
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
    await new Promise(resolve => setTimeout(resolve, observer.interval));
    try {
      log.flush();
      table = observer.read();
      const root = table.find(p => p.pid === child.pid);
      if (!state.child && root && root.ppid === process.pid) state.child = root;
      if (state.child) observed.set(state.child.pid, state.child);
      const alive = track(table, observed);
      state.descendants = alive.slice(0, 256);
      if (alive.length > 256) { uncertain = true; stop('descendant_tracking_limit'); }
      if (existsSync(join(dir, 'stop'))) stop('stop_requested');
      if (Date.now() - started >= spec.timeout_seconds * 1000) stop('timeout');
      if (exited && alive.length) stop('descendants_after_exit');
      if (stopping) {
        const signal = Date.now() - stopping >= 2000 ? 'SIGKILL' : 'SIGTERM';
        // Never signal a reused PID, or a process group whose leader identity
        // cannot be checked. Escaped observed descendants are signalled singly,
        // each checked against one table read after the group signal.
        const leader = table.find(p => p.pid === state.child?.pid);
        if (same(leader, state.child) && leader.pgid === leader.pid) {
          try { process.kill(-leader.pgid, signal); } catch (error) { state.diagnostic = failureDetails(error, 'signal_process_group'); /* individual identity checks below */ }
        }
        if (alive.length) {
          const current = observer.read();
          for (const p of alive) {
            try {
              if (same(current.find(x => x.pid === p.pid), p)) process.kill(p.pid, signal);
            } catch (error) { if (error.code !== 'ESRCH') { uncertain = true; state.diagnostic = failureDetails(error, 'signal_descendant'); } }
          }
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
