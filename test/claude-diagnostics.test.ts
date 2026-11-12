import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeDiagnostics } from '../src/claude-diagnostics.js';

function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'claude-diagnostics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('stderr retains split Unicode and attributes concurrent runs without mixing their text', t => {
  const root = setup(t), a = new ClaudeDiagnostics(root, 'auth', 1), b = new ClaudeDiagnostics(root, 'task', 2);
  const bytes = Buffer.from('ошибка 🔐\n');
  a.write(bytes.subarray(0, 3)); b.write(Buffer.from('separate run'));
  a.write(bytes.subarray(3)); a.finish(1, null); b.finish(0, null);
  const dir = join(root, 'diagnostics/claude');
  const records = readFileSync(join(dir, 'stderr.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.filter(r => r.run === a.id && r.event === 'stderr').map(r => r.text).join(''), bytes.toString());
  assert.equal(records.filter(r => r.run === b.id && r.event === 'stderr').map(r => r.text).join(''), 'separate run');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'stderr.jsonl')).mode & 0o777, 0o600);
});

test('noisy stderr is bounded across rotation and keeps the newest failure', t => {
  const root = setup(t), journal = new ClaudeDiagnostics(root, 'task', 1);
  const chunk = Buffer.alloc(65536, 0); // JSON escaping is larger than raw input.
  for (let i = 0; i < 24; i++) journal.write(chunk);
  journal.write(Buffer.from('newest failure')); journal.finish(1, null);
  const dir = join(root, 'diagnostics/claude'), files = readdirSync(dir);
  assert.equal(files.length, 4);
  for (const file of files) {
    assert.ok(statSync(join(dir, file)).size <= 1024 * 1024);
    assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
    for (const line of readFileSync(join(dir, file), 'utf8').trim().split('\n')) JSON.parse(line);
  }
  assert.match(readFileSync(join(dir, 'stderr.jsonl'), 'utf8'), /newest failure/);
});

test('diagnostic directory and file symlinks are not followed', t => {
  const root = setup(t), outside = join(root, 'outside'); mkdirSync(outside);
  const data = join(root, 'data'); mkdirSync(data);
  symlinkSync(outside, join(data, 'diagnostics'));
  const a = new ClaudeDiagnostics(data, 'auth'); a.write(Buffer.from('private')); a.finish(1, null);
  assert.match(a.hint(), /could not be saved/); assert.deepEqual(readdirSync(outside), []);
  const second = join(root, 'second'); mkdirSync(join(second, 'diagnostics/claude'), { recursive: true });
  const target = join(outside, 'target'); writeFileSync(target, 'original');
  symlinkSync(target, join(second, 'diagnostics/claude/stderr.jsonl'));
  const b = new ClaudeDiagnostics(second, 'auth'); b.write(Buffer.from('private')); b.finish(1, null);
  assert.match(b.hint(), /could not be saved/); assert.equal(readFileSync(target, 'utf8'), 'original');
});
