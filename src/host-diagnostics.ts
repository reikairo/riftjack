import { appendFileSync, closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, renameSync } from 'node:fs';
import { OwnerDiagnosticError } from './errors.js';
import { join } from 'node:path';

// The host owner can inspect original exception text and dependency stacks.
// Public replies use a separate summary; this representation is for the owner.
export function hostErrorDetails(error: unknown) {
  const nodes: Record<string, unknown>[] = [];
  const seen = new Map<object, number>();
  let truncated = false;
  const text = (value: unknown) => {
    if (typeof value !== 'string') return undefined;
    if (value.length > 16_384) truncated = true;
    return value.slice(0, 16_384);
  };
  const visit = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string') return { thrown: text(value) };
      return { thrown: ['number', 'boolean'].includes(typeof value) ? value : String(typeof value) };
    }
    if (seen.has(value)) return { ref: seen.get(value) };
    if (nodes.length >= 16) { truncated = true; return { omitted: true }; }
    const id = nodes.length;
    seen.set(value, id);
    const node: Record<string, unknown> = { id };
    nodes.push(node);
    const read = (key: string) => {
      try { return Reflect.get(value, key); }
      catch { node.unreadable = true; return undefined; }
    };
    for (const key of ['name', 'message', 'stack', 'code', 'errcode', 'syscall', 'status', 'statusCode', 'signal']) {
      const field = read(key);
      if (typeof field === 'string') node[key] = text(field);
      else if (typeof field === 'number' || typeof field === 'boolean') node[key] = field;
    }
    if (value instanceof OwnerDiagnosticError) {
      try { node.providerDetails = text(value.ownerDetails()); } catch { node.unreadable = true; }
    }
    const cause = read('cause');
    if (cause !== undefined) node.cause = visit(cause);
    const errors = read('errors');
    if (Array.isArray(errors)) {
      try {
        if (errors.length > 16) truncated = true;
        node.errors = errors.slice(0, 16).map(visit);
      }
      catch { node.unreadable = true; }
    }
    return { ref: id };
  };
  const root = visit(error);
  return { root, nodes, truncated };
}

export class HostDiagnosticLog {
  constructor(private directory: string, private maxBytes = 5 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new Error('Invalid diagnostic log size.');
  }
  write(error: unknown, context: Record<string, unknown>): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'errors.jsonl');
    const details = hostErrorDetails(error);
    let line = JSON.stringify({ ...context, errorDetails: details }) + '\n';
    // Bound individual records as well as retained files. Oversized exceptions
    // still retain their summary and explicitly report the omitted details.
    if (Buffer.byteLength(line) > Math.min(this.maxBytes, 256 * 1024)) {
      line = JSON.stringify({ ...context, errorDetails: { truncated: true, reason: 'record-size-limit' } }) + '\n';
    }
    if (Buffer.byteLength(line) > this.maxBytes) throw new Error('Diagnostic context exceeds the log size.');
    const open = () => openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    let fd: number | undefined = open();
    try {
      fchmodSync(fd, 0o600);
      if (fstatSync(fd).size + Buffer.byteLength(line) > this.maxBytes) {
        closeSync(fd); fd = undefined;
        const previous = path + '.1';
        renameSync(path, previous);
        fd = open();
        fchmodSync(fd, 0o600);
      }
      appendFileSync(fd, line);
    } finally { if (fd !== undefined) closeSync(fd); }
  }
}
