import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeHistory } from '../src/history.js';

test('inaccessible snapshot sources are not hashed as absent files', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, t => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-stat-'));
  const source = join(root, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'package.json'), '{}');
  t.after(() => { chmodSync(source, 0o700); rmSync(root, { recursive: true, force: true }); });
  const history = new CodeHistory(source, join(root, 'history'), ['package.json']);
  chmodSync(source, 0);
  for (const action of [() => history.hash(), () => history.capture()]) {
    assert.throws(action, { code: 'EACCES' });
  }
});

test('genuinely missing optional snapshot files remain supported', t => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{}');
  const history = new CodeHistory(root, join(root, 'history'), ['package.json', 'optional.json']);
  const snapshot = history.capture();
  assert.equal(history.hash(snapshot.path), history.hash());
  assert.ok(history.promote(snapshot));
});
