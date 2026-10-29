import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPiBackend } from '../src/pi-backend.js';
import { loadConfig } from '../src/config.js';
import { State } from '../src/state.js';

function setup(t: test.TestContext, scenario: string) {
  const dir = mkdtempSync(join(tmpdir(), 'riftjack-pi-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'scenario'), scenario);
  const cli = join(dir, 'pi');
  writeFileSync(cli, readFileSync(new URL('./fixtures/pi-rpc.cjs', import.meta.url), 'utf8').replace('#!/usr/bin/env node', `#!${process.execPath}`));
  chmodSync(cli, 0o700);
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://example.com', MATRIX_OWNER_ID: '@owner:example.com',
    RIFTJACK_WORKSPACE: dir, DATA_DIR: join(dir, 'data'), PI_PATH: cli });
  const state = new State(join(dir, 'state.json'));
  return { dir, state, run: createPiBackend(config, state) };
}

test('Pi validates readiness and session before prompting and persists the session', async t => {
  const { run, state } = setup(t, 'normal');
  assert.equal(await run('pi', 'Task', 'key', AbortSignal.timeout(5000), '@owner:example.com'), 'Finished.');
  assert.ok(state.session('key').pi);
});

for (const scenario of ['wrong-nonce', 'stderr-only', 'wrong-session']) {
  test(`Pi refuses to prompt with ${scenario}`, async t => {
    const { run, state, dir } = setup(t, scenario);
    await assert.rejects(run('pi', 'Task', 'key', AbortSignal.timeout(600), '@owner:example.com'));
    assert.equal(existsSync(join(dir, 'prompt-received')), false);
    assert.equal(state.session('key').pi, undefined);
  });
}

test('Pi returns only the last assistant message, preserving exact NO_REPLY', async t => {
  const { run } = setup(t, 'partial');
  assert.equal(await run('pi', 'Task', 'key', AbortSignal.timeout(5000), '@owner:example.com'), 'NO_REPLY');
});

test('Pi does not reuse a preamble when the final assistant message is empty', async t => {
  const { run } = setup(t, 'empty-final');
  assert.equal(await run('pi', 'Task', 'key', AbortSignal.timeout(5000), '@owner:example.com'), 'Pi completed without a text reply.');
});

test('Pi rejects model failure instead of returning partial output', async t => {
  const { run } = setup(t, 'error');
  await assert.rejects(run('pi', 'Task', 'key', AbortSignal.timeout(5000), '@owner:example.com'), /could not complete/);
});

test('Pi denies tool confirmation when no interaction is available', async t => {
  const { run } = setup(t, 'approval');
  assert.equal(await run('pi', 'Task', 'key', AbortSignal.timeout(5000), '@owner:example.com'), 'Denied.');
});

test('Pi cancels SIGTERM-ignoring descendants even when their parent exits first', { skip: process.platform === 'win32' }, async t => {
  const { run, dir } = setup(t, 'descendant');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const promise = run('pi', 'Task', 'key', controller.signal, '@owner:example.com');
  const rejected = assert.rejects(promise, /cancel fixture/);
  for (let n = 0; n < 300 && !existsSync(join(dir, 'child-ready')); n++) await delay(10);
  assert.ok(existsSync(join(dir, 'child-ready')));
  controller.abort(new Error('cancel fixture'));
  await rejected;
  await delay(1000);
  assert.equal(existsSync(join(dir, 'survived')), false);
});
