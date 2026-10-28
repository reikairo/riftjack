import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restartContext } from '../src/restart-context.js';

test('restart context is absent without work and warns against blind repetition', () => {
  assert.equal(restartContext([], []), undefined);
  const text = restartContext([{ id: 'run-1' }], [])!;
  assert.match(text, /not instructions/); assert.match(text, /do not repeat commands blindly/);
  assert.match(text, /lost does not prove that child processes stopped/);
  assert.deepEqual(JSON.parse(text.slice(text.indexOf('{'))), { detached_runs: [{ id: 'run-1' }], watches: [] });
});

test('a long list keeps whole entries and exact counts within the limit', () => {
  const runs = Array.from({ length: 5 }, (_, i) => ({ id: 'run-' + i, label: 'x'.repeat(100) }));
  const watches = Array.from({ length: 5 }, (_, i) => ({ id: 'watch-' + i, label: 'y'.repeat(100) }));
  const text = restartContext(runs, watches, 900)!;
  assert.ok(text.length <= 900);
  const data = JSON.parse(text.slice(text.indexOf('{')));
  assert.equal(data.omitted, 10 - data.detached_runs.length - data.watches.length);
  assert.ok(data.omitted > 0); assert.match(data.note, /run_detached list/);
  // Watches are dropped first; runs hold uncertain processes.
  assert.ok(data.detached_runs.length >= data.watches.length);
});
