import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunJournal } from '../src/run-journal.js';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'run-journal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'runs.json');
  return { file, journal: new RunJournal(file), read: () => JSON.parse(readFileSync(file, 'utf8')).entries };
}

test('journal persists stages and recovers unfinished runs without replaying or losing their last stage', t => {
  const f = fixture(t);
  for (const stage of ['preparing', 'running', 'delivering'] as const) {
    const id = f.journal.begin('scope', '$' + stage);
    f.journal.update(id, stage);
  }
  const done = f.journal.begin('scope', '$done');
  f.journal.update(done, 'delivering', 'completed');
  const restored = new RunJournal(f.file);
  assert.deepEqual(f.read().map((e: any) => [e.stage, e.outcome]), [
    ['preparing', 'interrupted'], ['running', 'interrupted'], ['delivering', 'interrupted'], ['delivering', 'completed'],
  ]);
  const saved = readFileSync(f.file, 'utf8');
  new RunJournal(f.file);
  assert.equal(readFileSync(f.file, 'utf8'), saved);
  assert.match(restored.summary('scope'), /never replayed/);
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
});

test('journal limits history and does not discard active runs', t => {
  const f = fixture(t), active = f.journal.begin('active', '$active');
  for (let i = 0; i < 150; i++) {
    const id = f.journal.begin('scope', '$' + i);
    f.journal.update(id, 'delivering', 'completed');
  }
  assert.equal(f.read().length, 100);
  assert.equal(f.read()[0].id, active);
  assert.equal((f.journal.summary('scope').match(/last stage:/g) ?? []).length, 5);
  for (let i = 0; i < 99; i++) f.journal.begin('active', '$more' + i);
  assert.equal(f.read().length, 100);
  assert.ok(f.read().every((e: any) => !e.outcome));
  assert.throws(() => f.journal.begin('active', '$overflow'), /full/);
});

test('journal scopes summaries to the conversation and refuses malformed state', t => {
  const f = fixture(t);
  const id = f.journal.begin('private scope', '$private');
  f.journal.update(id, 'running', 'failed');
  assert.equal(f.journal.summary('other scope'), '');
  assert.throws(() => f.journal.update(id, 'delivering'), /No active/);
  const valid = f.read()[0];
  for (const data of [null, {}, { version: 2, entries: [] }, { version: 1, entries: [{ ...valid, stage: 'unknown' }] },
    { version: 1, entries: [{ ...valid, updated: 1e308 }] }, { version: 1, entries: Array(101).fill(valid) }]) {
    writeFileSync(f.file, JSON.stringify(data));
    assert.throws(() => new RunJournal(f.file), /Invalid run journal/);
  }
});

test('failed persistence leaves memory unchanged and blocks a new run', t => {
  const f = fixture(t);
  mkdirSync(f.file + '.tmp');
  assert.throws(() => f.journal.begin('scope', '$1'));
  assert.equal(f.journal.summary('scope'), '');
});
