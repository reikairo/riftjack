import { constants, mkdirSync, lstatSync, chmodSync, openSync, fstatSync, fchmodSync, closeSync, writeSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { safeErrorSummary } from './errors.js';

const MAX_BYTES = 1024 * 1024;
const ARCHIVES = 3;
const HOST_PATH = 'DATA_DIR/diagnostics/claude/stderr.jsonl';

// Writes are synchronous and bounded so concurrent children in one connector
// cannot race rotation or build an unbounded queue when stderr is noisy.
function append(dataDir: string, record: object) {
  let dir = resolve(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of ['diagnostics', 'claude']) {
    dir = join(dir, name);
    try { mkdirSync(dir, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const st = lstatSync(dir);
    if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) throw new Error('Unsafe diagnostic directory');
    chmodSync(dir, 0o700);
  }
  const file = join(dir, 'stderr.jsonl');
  const bytes = Buffer.from(JSON.stringify(record) + '\n');
  if (bytes.length > MAX_BYTES) throw new Error('Oversized diagnostic record');
  const open = () => {
    const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || (process.getuid && st.uid !== process.getuid())) throw new Error('Unsafe diagnostic file');
      fchmodSync(fd, 0o600);
      return { fd, size: st.size };
    } catch (error) { closeSync(fd); throw error; }
  };
  let current = open();
  try {
    if (current.size + bytes.length > MAX_BYTES) {
      closeSync(current.fd); current.fd = -1;
      // Harden existing archives too; never read or follow a link.
      for (let i = 1; i <= ARCHIVES; i++) {
        const path = file + '.' + i;
        try {
          const st = lstatSync(path);
          if (!st.isFile() || st.nlink !== 1 || (process.getuid && st.uid !== process.getuid())) throw new Error('Unsafe diagnostic archive');
          chmodSync(path, 0o600);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      try { unlinkSync(file + '.' + ARCHIVES); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      for (let i = ARCHIVES - 1; i >= 1; i--) {
        try { renameSync(file + '.' + i, file + '.' + (i + 1)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      renameSync(file, file + '.1');
      current = open();
    }
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(current.fd, bytes, offset);
  } finally { if (current.fd !== -1) closeSync(current.fd); }
}

export class ClaudeDiagnostics {
  readonly id = randomUUID();
  private decoder = new StringDecoder('utf8');
  private failure?: string;
  constructor(private dataDir: string, operation: 'help' | 'auth' | 'usage' | 'task', pid?: number) {
    this.record({ event: 'start', operation, pid });
  }
  private record(fields: object) {
    if (this.failure) return;
    try { append(this.dataDir, { time: new Date().toISOString(), run: this.id, ...fields }); }
    catch (error) { this.failure = safeErrorSummary(error); }
  }
  write(chunk: Buffer) {
    if (this.failure) return;
    for (let i = 0; i < chunk.length; i += 8192) {
      const text = this.decoder.write(chunk.subarray(i, i + 8192));
      if (text) this.record({ event: 'stderr', text });
    }
  }
  finish(code: number | null, signal: string | null) {
    const text = this.decoder.end();
    if (text) this.record({ event: 'stderr', text });
    this.record({ event: 'exit', code, signal });
  }
  hint() {
    return this.failure
      ? ` Local Claude diagnostics could not be saved (${this.failure}).`
      : ` Local Claude diagnostic ID: ${this.id}; host log: ${HOST_PATH} (including rotated files).`;
  }
}
