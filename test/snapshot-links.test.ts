import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeHistory } from '../src/history.js';

for (const kind of ['file', 'directory', 'dangling'] as const) {
  test(`launch snapshots refuse ${kind} symlinks instead of certifying unfrozen code`, t => {
    const root = mkdtempSync(join(tmpdir(), 'snapshot-links-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'src'));
    const target = join(root, 'external');
    if (kind === 'directory') {
      mkdirSync(target);
      writeFileSync(join(target, 'module.ts'), 'original');
    } else if (kind === 'file') writeFileSync(target, 'original');
    symlinkSync(target, join(root, 'src', 'linked'));
    const snapshots = join(root, 'snapshots');
    const history = new CodeHistory(root, snapshots);
    assert.throws(() => history.capture(), /symbolic link/i);
    assert.equal(history.latest(), undefined);
    assert.deepEqual(readdirSync(root).filter(name => name === 'snapshots'), []);
  });
}

test('an existing snapshot with a symlink cannot be promoted or restored', t => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  const source = join(root, 'src', 'module.ts');
  writeFileSync(source, 'original');
  const history = new CodeHistory(root, join(root, 'snapshots'));
  const candidate = history.capture();
  symlinkSync(source, join(candidate.path, 'src', 'linked'));
  assert.throws(() => history.promote(candidate), /symbolic link/i);
  rmSync(join(candidate.path, 'src', 'linked'));
  history.promote(candidate);
  symlinkSync(source, join(history.latest()!.path, 'src', 'linked'));
  writeFileSync(source, 'changed');
  assert.throws(() => history.rollback(), /symbolic link/i);
  assert.equal(readFileSync(source, 'utf8'), 'changed');
});
