import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { processes } from '../scripts/detached-runner.mjs';
import { PublicError, errorMessage } from './errors.js';

export type ProcessProbe = (pid: number) => { birth: string; state: string } | undefined;
export const probeProcess: ProcessProbe = pid => processes().find(p => p.pid === pid);
type Condition = { operator: 'equals' | 'not_equals' | 'starts_with'; value: string };
export type WatchConditions = {
  mode: 'json' | 'text' | 'process' | 'idle';
  file?: string; field?: string; terminal?: string[]; text?: Condition;
  process?: { pid: number; birth: string }; exitFile?: string; exitFingerprint?: string;
  idle?: { file: string; seconds: number; fingerprint: string; changed: number };
};
export type Observation = { status?: string; line?: string; value?: string; exit_code?: number; exit_code_source?: string;
  process?: 'exists' | 'missing' | 'reused' | 'unknown'; idle_seconds?: number; error?: string; file?: string };
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v);
const pid = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
const seconds = (v: unknown): v is number => Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 604800;
const condition = (v: unknown): v is Condition => object(v) && Object.keys(v).every(k => ['operator', 'value'].includes(k)) &&
  ['equals', 'not_equals', 'starts_with'].includes(v.operator) && string(v.value, 1024);

// Revalidate confinement at every read, including after a symlink is replaced.
// Idle checks stat the open regular file; they never read a potentially huge log.
export function watchFile(workspace: string, file: string, content = false) {
  const path = realpathSync(resolve(workspace, file));
  const rel = relative(workspace, path);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new PublicError('Watched files must remain inside the bot workspace.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new PublicError('Use a regular file for a watch.');
    let text: string | undefined;
    if (content) {
      if (stat.size > 65536) throw new PublicError('Use a result file of at most 64 KiB.');
      const buffer = Buffer.alloc(65537);
      let size = 0, count: number;
      while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null))) size += count;
      if (size > 65536) throw new PublicError('Result file exceeds 64 KiB.');
      text = buffer.subarray(0, size).toString('utf8');
    }
    return { file: resolve(workspace, file), text, modified: stat.mtimeMs,
      fingerprint: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
  } finally { closeSync(fd); }
}
const firstLine = (text: string) => text.split(/\r?\n/).map(s => s.trim()).find(Boolean);

export function validWatchConditions(v: unknown): v is WatchConditions {
  if (!object(v) || !['json', 'text', 'process', 'idle'].includes(v.mode)) return false;
  if (v.mode === 'json' && (!string(v.file) || !string(v.field, 80) || !Array.isArray(v.terminal) || !v.terminal.length || v.terminal.length > 16 || !v.terminal.every((s: unknown) => string(s, 80)))) return false;
  if (v.mode === 'text' && (!string(v.file) || !condition(v.text))) return false;
  if (v.mode === 'process' && (!object(v.process) || !pid(v.process.pid) || !string(v.process.birth, 128))) return false;
  if (v.exitFile !== undefined && (v.mode !== 'process' || !string(v.exitFile) || !string(v.exitFingerprint))) return false;
  if (v.mode === 'idle' && !v.idle) return false;
  return v.idle === undefined || (object(v.idle) && string(v.idle.file) && seconds(v.idle.seconds) && string(v.idle.fingerprint) && Number.isFinite(v.idle.changed));
}

export function prepareConditions(input: Record<string, unknown>, workspace: string, now: number, probe: ProcessProbe): WatchConditions {
  const mode = input.mode ?? 'json';
  const allowed = ['action', 'label', 'mode', 'timeout_hours', 'idle_file', 'idle_seconds',
    ...(mode === 'json' ? ['status_file', 'field', 'terminal'] : mode === 'text' ? ['status_file', 'text_condition'] : mode === 'process' ? ['pid', 'exit_code_file'] : [])];
  if (!['json', 'text', 'process', 'idle'].includes(String(mode)) || Object.keys(input).some(k => !allowed.includes(k))) throw new PublicError('Use mode json, text, process or idle with only that mode\'s fields.');
  const spec: WatchConditions = { mode: mode as WatchConditions['mode'] };
  if (mode === 'json' || mode === 'text') {
    if (!string(input.status_file)) throw new PublicError('Provide status_file inside the bot workspace.');
    const file = watchFile(workspace, input.status_file, true);
    spec.file = file.file;
    if (mode === 'json') {
      if (!string(input.field, 80) || !Array.isArray(input.terminal) || !input.terminal.length || input.terminal.length > 16 || !input.terminal.every(s => string(s, 80))) throw new PublicError('JSON watches need field and terminal string values.');
      if (!object(JSON.parse(file.text!))) throw new PublicError('Status must be a JSON object.');
      spec.field = input.field; spec.terminal = [...new Set(input.terminal as string[])].sort();
    } else {
      if (!condition(input.text_condition)) throw new PublicError('Text watches need text_condition with operator equals, not_equals or starts_with and a nonempty value.');
      spec.text = { ...input.text_condition };
    }
  }
  if (mode === 'process') {
    if (!pid(input.pid)) throw new PublicError('Process watches need a positive pid on this host.');
    let identity;
    try { identity = probe(input.pid); } catch (cause) { throw new PublicError('Cannot establish the process start identity.', { cause }); }
    if (!identity || identity.state.startsWith('Z')) throw new PublicError('Register a process watch while that process is alive.');
    spec.process = { pid: input.pid, birth: identity.birth };
    if (input.exit_code_file !== undefined) {
      if (!string(input.exit_code_file)) throw new PublicError('Use an exit_code_file inside the workspace.');
      const file = watchFile(workspace, input.exit_code_file, true);
      spec.exitFile = file.file; spec.exitFingerprint = file.fingerprint;
    }
  }
  if (mode === 'idle' || input.idle_file !== undefined || input.idle_seconds !== undefined) {
    if (!string(input.idle_file) || !seconds(input.idle_seconds)) throw new PublicError('Provide idle_file and idle_seconds (1–604800).');
    const file = watchFile(workspace, input.idle_file);
    spec.idle = { file: file.file, seconds: input.idle_seconds, fingerprint: file.fingerprint, changed: Math.min(file.modified, now) };
  }
  return spec;
}
export const watchInterval = (spec: WatchConditions) => spec.idle ? Math.max(1000, Math.min(60000, Math.floor(spec.idle.seconds / 5) * 1000)) : 2000;
export const conditionKey = (spec: WatchConditions) => JSON.stringify({ ...spec, exitFingerprint: undefined, ...(spec.idle && { idle: { file: spec.idle.file, seconds: spec.idle.seconds } }) });

export function observeConditions(spec: WatchConditions, workspace: string, now: number, probe: ProcessProbe): Observation {
  const result: Observation = {};
  let reading = spec.file;
  try {
    if (spec.mode === 'text' || spec.mode === 'json') {
      const file = watchFile(workspace, spec.file!, true);
      if (spec.mode === 'text') {
        const line = firstLine(file.text!);
        if (line && line.length > 1024) throw new PublicError('The first nonempty result line exceeds 1024 characters.');
        result.line = line;
        if (line !== undefined && (spec.text!.operator === 'equals' ? line === spec.text!.value : spec.text!.operator === 'not_equals' ? line !== spec.text!.value : line.startsWith(spec.text!.value))) {
          result.status = 'watch_text_matched'; return result;
        }
      } else {
        const value: unknown = JSON.parse(file.text!);
        if (!object(value)) throw new PublicError('Status must be a JSON object.');
        const status = Object.hasOwn(value, spec.field!) ? value[spec.field!] : undefined;
        if (typeof status === 'string' && status.length <= 80) result.value = status;
        if (typeof status === 'string' && spec.terminal!.includes(status)) { result.status = status; return result; }
      }
    }
    if (spec.process) {
      let current;
      try { current = probe(spec.process.pid); }
      catch (error) { result.process = 'unknown'; result.error = errorMessage(error, 'Process inspection failed'); }
      if (result.process !== 'unknown') {
        result.process = !current ? 'missing' : current.birth !== spec.process.birth ? 'reused' : current.state.startsWith('Z') ? 'missing' : 'exists';
        if (result.process !== 'exists') {
          result.status = result.process === 'reused' ? 'watch_process_reused' : 'watch_process_exited';
          if (spec.exitFile && result.process === 'missing') {
            try {
              const file = watchFile(workspace, spec.exitFile, true);
              const line = firstLine(file.text!);
              // Require a fresh result, not an old code left by a previous run.
              if (line && /^(?:exit )?-?\d{1,10}$/.test(line) && file.fingerprint !== spec.exitFingerprint && file.modified >= Date.parse(spec.process.birth)) {
                const code = Number(line.replace(/^exit /, ''));
                if (Number.isSafeInteger(code)) { result.exit_code = code; result.exit_code_source = spec.exitFile; }
              }
            } catch (error) { result.error = errorMessage(error, 'Exit code file could not be read'); }
          }
          return result;
        }
      }
    }
    if (spec.idle) {
      reading = spec.idle.file;
      const file = watchFile(workspace, reading);
      if (file.fingerprint !== spec.idle.fingerprint) { spec.idle.fingerprint = file.fingerprint; spec.idle.changed = now; }
      result.idle_seconds = Math.max(0, Math.floor((now - spec.idle.changed) / 1000));
      if (now - spec.idle.changed >= spec.idle.seconds * 1000) result.status = 'watch_file_idle';
    }
  } catch (error) {
    result.status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'watch_file_missing' : 'watch_file_unreadable';
    result.file = reading; result.error = errorMessage(error, 'Reading watched file failed');
  }
  return result;
}

export function describeConditions(spec: WatchConditions) {
  return { mode: spec.mode, ...(spec.file && { status_file: spec.file }),
    ...(spec.field && { field: spec.field, terminal: spec.terminal }),
    ...(spec.text && { text_condition: spec.text }),
    ...(spec.process && { pid: spec.process.pid, process_started: spec.process.birth }),
    ...(spec.exitFile && { exit_code_file: spec.exitFile }),
    ...(spec.idle && { idle_file: spec.idle.file, idle_seconds: spec.idle.seconds, last_change: new Date(spec.idle.changed).toISOString() }),
    poll_interval_seconds: watchInterval(spec) / 1000 };
}
