import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = 'https://github.com/reikairo/riftjack';
const isRevision = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
export type CodeVersion = { revision: string; dirty: boolean };

// Capture once, from the code directory, never from the instance's working directory.
// No network access, remote URLs, commit messages or other repository text enters a prompt.
export function codeVersion(directory = fileURLToPath(new URL('..', import.meta.url))): CodeVersion | undefined {
  try {
    const env = { ...process.env };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[name];
    const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', directory, ...args],
      { env, encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(directory)) return;
    const revision = git('rev-parse', '--verify', 'HEAD^{commit}');
    if (!isRevision(revision)) return;
    return { revision, dirty: !!git('status', '--porcelain', '--untracked-files=normal') };
  } catch { return; } // Source archives and hosts without git still start normally.
}

export class StartupVersion {
  readonly summary: string;
  readonly releaseNotes: string;

  constructor(private file: string, private current = codeVersion(), notesFile = fileURLToPath(new URL('../docs/release-notes.md', import.meta.url))) {
    // Keep the running instance's notes even if its checkout is later updated.
    let markdown: string | undefined;
    let unavailable: string | undefined;
    try {
      const fd = openSync(notesFile, 'r');
      try {
        const buffer = Buffer.alloc(256 * 1024 + 1);
        let size = 0, count: number;
        while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null))) size += count;
        if (size === buffer.length) unavailable = 'Release notes exceed the 256 KiB limit.';
        else markdown = buffer.subarray(0, size).toString('utf8');
      } finally { closeSync(fd); }
    } catch { unavailable = 'Release notes were unavailable at connector startup.'; }
    this.releaseNotes = JSON.stringify({
      revision: current && isRevision(current.revision) ? current.revision : null,
      dirty: current && isRevision(current.revision) ? current.dirty : null,
      source: 'startup snapshot', markdown, unavailable,
    });
    let previous: unknown;
    try { previous = JSON.parse(readFileSync(file, 'utf8')).revision; } catch { /* No trustworthy baseline. */ }
    if (!current || !isRevision(current.revision)) {
      this.summary = 'Code revision unavailable; an update cannot be determined.';
      return;
    }
    const { revision, dirty } = current;
    const changed = isRevision(previous) && previous !== revision;
    this.summary = changed
      ? `Riftjack code changed since the previous successful startup: ${previous} -> ${revision} (an update or rollback).`
      : isRevision(previous) ? `Riftjack revision: ${revision} (unchanged).`
        : `Riftjack revision: ${revision}. No previous successful startup revision is recorded.`;
    if (dirty) this.summary += '\nLocal changes are present; revision links describe committed code only.';
    if (changed || !isRevision(previous)) {
      this.summary += `\nRelease notes: ${repository}/blob/${revision}/docs/release-notes.md`;
      if (changed) this.summary += `\nRevision comparison: ${repository}/compare/${previous}..${revision}`;
    }
  }

  notice(worker = false): string {
    return this.summary + '\nRead the running version’s release notes with ' + (worker
      ? 'worker-client.py release-notes (using your configured worker credentials).'
      : 'the Riftjack release_notes tool (no arguments).');
  }

  // Call only after the connector is ready. Failed startups must not erase the baseline.
  ready(): void {
    if (!this.current || !isRevision(this.current.revision)) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.current) + '\n', { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}
