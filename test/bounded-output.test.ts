import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundedOutput } from '../scripts/detached-runner.mjs';
test('many output chunks coalesce into one bounded flush, including a final short chunk', t => {
  const root = mkdtempSync(join(tmpdir(), 'bounded-output-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'output.log'), output = new BoundedOutput(path, 100);
  for (let i = 0; i < 1000; i++) output.append(Buffer.from('abcd'));
  assert.equal(existsSync(path), false, 'data callbacks do not rewrite the file');
  output.flush(); assert.equal(readFileSync(path, 'utf8'), 'abcd'.repeat(25)); assert.equal(output.truncated, true);
  const modified = statSync(path).mtimeMs;
  output.flush(); assert.equal(statSync(path).mtimeMs, modified, 'unchanged output is not rewritten');
  output.append(Buffer.from('end')); output.flush();
  assert.equal(readFileSync(path, 'utf8'), ('abcd'.repeat(25) + 'end').slice(-100));
});
test('failed log flush keeps buffered output retryable and leaves the previous log intact', t => {
  const root = mkdtempSync(join(tmpdir(), 'bounded-output-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'output.log'), output = new BoundedOutput(path, 100);
  output.append(Buffer.from('before')); output.flush();
  mkdirSync(path + '.tmp'); output.append(Buffer.from('after'));
  assert.throws(() => output.flush()); assert.equal(readFileSync(path, 'utf8'), 'before');
  rmSync(path + '.tmp', { recursive: true }); output.flush();
  assert.equal(readFileSync(path, 'utf8'), 'beforeafter');
});
