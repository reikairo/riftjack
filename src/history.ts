import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Code that a restarted connector loads. node_modules, .env and data/ are deliberately excluded.
export const CODE_FILES = ['src', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json'];

export type Snapshot = { name: string; path: string; hash: string };

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(2).toString('hex');
}

export class CodeHistory {
  constructor(readonly root: string, readonly dir: string, private files = CODE_FILES, private keep = 10) {}

  hash(base = this.root): string {
    const hash = createHash('sha256');
    const walk = (relative: string) => {
      const path = join(base, relative);
      let stat;
      try { stat = lstatSync(path); } catch { hash.update('missing\0' + relative + '\0'); return; }
      if (stat.isDirectory()) {
        hash.update('dir\0' + relative + '\0');
        for (const entry of readdirSync(path).sort()) walk(join(relative, entry));
      } else if (stat.isFile()) {
        hash.update('file\0' + relative + '\0').update(readFileSync(path)).update('\0');
      }
    };
    for (const file of this.files) walk(file);
    return hash.digest('hex');
  }

  private list(prefix: 'good-' | 'failed-'): Snapshot[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter(name => name.startsWith(prefix)).sort().flatMap(name => {
      try {
        const { hash, files } = JSON.parse(readFileSync(join(this.dir, name, 'manifest.json'), 'utf8'));
        return typeof hash === 'string' && JSON.stringify(files) === JSON.stringify(this.files) ? [{ name, path: join(this.dir, name), hash }] : [];
      } catch { return []; }
    });
  }

  latest(): Snapshot | undefined { return this.list('good-').at(-1); }

  private prune(prefix: 'good-' | 'failed-'): void {
    for (const old of this.list(prefix).slice(0, -this.keep)) rmSync(old.path, { recursive: true, force: true });
  }

  // Freeze a candidate before launch; it is not a rollback target until promoted.
  capture(): Snapshot {
    const hash = this.hash();
    const name = 'pending-' + stamp();
    const path = join(this.dir, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    try {
      for (const file of this.files) {
        if (existsSync(join(this.root, file))) cpSync(join(this.root, file), join(path, file), { recursive: true });
      }
      if (this.hash(path) !== hash || this.hash() !== hash) throw new Error('Code changed while capturing the launch snapshot.');
      writeFileSync(join(path, 'manifest.json'), JSON.stringify({ hash, files: this.files, createdAt: new Date().toISOString() }));
      return { name, path, hash };
    } catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
  }

  discard(snapshot: Snapshot): void { rmSync(snapshot.path, { recursive: true, force: true }); }

  // Promote the frozen launch candidate, never the current working tree.
  promote(snapshot: Snapshot): string | undefined {
    if (this.hash(snapshot.path) !== snapshot.hash) throw new Error('Launch snapshot changed.');
    if (this.latest()?.hash === snapshot.hash) { this.discard(snapshot); return; }
    const name = 'good-' + stamp();
    renameSync(snapshot.path, join(this.dir, name));
    this.prune('good-');
    return name;
  }

  // Restores the latest known-good code. The replaced code is kept in a failed-* snapshot.
  rollback(): { snapshot: string; failed: string } | undefined {
    const good = this.latest();
    const hash = this.hash();
    if (!good || good.hash === hash) return;
    if (this.hash(good.path) !== good.hash) throw new Error('Rollback snapshot is incomplete or changed; no files were restored.');
    // Installed dependencies are not part of a source snapshot. Do not knowingly
    // restore source requiring a different installation into a running environment.
    const lock = (base: string) => existsSync(join(base, 'package-lock.json')) ? readFileSync(join(base, 'package-lock.json'), 'utf8') : '';
    if (existsSync(join(this.root, 'node_modules')) && lock(this.root) !== lock(good.path)) {
      throw new Error('Rollback requires a different dependency installation. Restore the version and run npm ci before starting.');
    }
    const failed = join(this.dir, 'failed-' + stamp());
    mkdirSync(failed, { recursive: true, mode: 0o700 });
    writeFileSync(join(failed, 'manifest.json'), JSON.stringify({ hash, files: this.files, createdAt: new Date().toISOString(), restored: good.name }));
    for (const file of this.files) {
      if (existsSync(join(this.root, file))) renameSync(join(this.root, file), join(failed, file));
    }
    for (const file of this.files) {
      if (existsSync(join(good.path, file))) cpSync(join(good.path, file), join(this.root, file), { recursive: true });
    }
    this.prune('failed-');
    return { snapshot: good.name, failed: failed };
  }
}
