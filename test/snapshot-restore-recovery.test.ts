import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeHistory } from '../src/history.js';

for (const stage of ['copy', 'backup', 'install']) test(`rollback ${stage} failure preserves the pre-rollback tree`, t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'snapshot-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = ['a.txt', 'b.txt', 'optional.txt'];
  const history = new CodeHistory(root, join(root, '.history'), files);
  for (const file of files) fs.writeFileSync(join(root, file), 'known good ' + file);
  history.promote(history.capture());
  fs.writeFileSync(join(root, 'a.txt'), 'current a');
  fs.writeFileSync(join(root, 'b.txt'), 'current b');
  fs.rmSync(join(root, 'optional.txt'));
  const before = history.hash();
  const failure = Object.assign(new Error('Injected filesystem failure during ' + stage), { code: 'EIO' });
  let injected = false;
  const copy = fs.cpSync, rename = fs.renameSync;
  const copyMock = t.mock.method(fs, 'cpSync', (...[source, destination, options]: Parameters<typeof fs.cpSync>) => {
    if (!injected && stage === 'copy') { injected = true; throw failure; }
    return copy(source, destination, options);
  });
  const renameMock = t.mock.method(fs, 'renameSync', (...[source, destination]: Parameters<typeof fs.renameSync>) => {
    const sourcePath = String(source), destinationPath = String(destination);
    if (!injected && ((stage === 'backup' && sourcePath === join(root, 'b.txt')) ||
      (stage === 'install' && destinationPath === join(root, 'b.txt')))) {
      injected = true; throw failure;
    }
    return rename(source, destination);
  });
  syncBuiltinESMExports();
  t.after(() => { copyMock.mock.restore(); renameMock.mock.restore(); syncBuiltinESMExports(); });
  if (stage === 'install') {
    // Older rollback copies directly into the live tree; exercise that failure too.
    copyMock.mock.mockImplementation((...[source, destination, options]: Parameters<typeof fs.cpSync>) => {
      if (!injected && String(destination) === join(root, 'b.txt')) { injected = true; throw failure; }
      return copy(source, destination, options);
    });
  }
  assert.throws(() => history.rollback(), error => error === failure);
  assert.equal(injected, true);
  assert.equal(history.hash(), before);
  assert.equal(fs.readFileSync(join(root, 'a.txt'), 'utf8'), 'current a');
  assert.equal(fs.readFileSync(join(root, 'b.txt'), 'utf8'), 'current b');
  assert.equal(fs.existsSync(join(root, 'optional.txt')), false);
  assert.ok(history.rollback());
  assert.equal(fs.readFileSync(join(root, 'a.txt'), 'utf8'), 'known good a.txt');
  assert.equal(fs.readFileSync(join(root, 'optional.txt'), 'utf8'), 'known good optional.txt');
});

test('rollback preserves backup and staging artifacts if recovering a moved file also fails', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'snapshot-double-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const history = new CodeHistory(root, join(root, '.history'), ['a.txt', 'b.txt']);
  for (const file of ['a.txt', 'b.txt']) fs.writeFileSync(join(root, file), 'good ' + file);
  history.promote(history.capture());
  for (const file of ['a.txt', 'b.txt']) fs.writeFileSync(join(root, file), 'current ' + file);
  const initial = Object.assign(new Error('Replacement failed'), { code: 'EIO' });
  const recovery = Object.assign(new Error('Recovery failed'), { code: 'EACCES' });
  const rename = fs.renameSync;
  let recovering = false;
  const mock = t.mock.method(fs, 'renameSync', (...[source, destination]: Parameters<typeof fs.renameSync>) => {
    if (!recovering && String(destination) === join(root, 'b.txt')) { recovering = true; throw initial; }
    if (recovering && String(source) === join(root, 'a.txt')) throw recovery;
    return rename(source, destination);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  assert.throws(() => history.rollback(), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [initial, recovery]);
    return true;
  });
  const entries = fs.readdirSync(history.dir);
  const failed = entries.find(name => name.startsWith('failed-'))!;
  const staged = entries.find(name => name.startsWith('restore-'))!;
  assert.ok(failed); assert.ok(staged);
  assert.equal(fs.readFileSync(join(history.dir, failed, 'a.txt'), 'utf8'), 'current a.txt');
  assert.equal(fs.readFileSync(join(history.dir, staged, 'b.txt'), 'utf8'), 'good b.txt');
  assert.equal(fs.readFileSync(join(root, 'b.txt'), 'utf8'), 'current b.txt');
});
