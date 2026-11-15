import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundTasks } from '../src/background-tasks.js';

const target = { room: '!home:example.com', sender: '@alice:example.com', key: 'key', session: 'session' };
for (const deliver of ['agent', 'room']) for (const series of [false, true]) {
  test(`failed ${deliver} admission keeps ${series ? 'series slot' : 'one-shot reminder'} retryable`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'background-admission-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, 'state.json'), queue = new BackgroundTasks(file, root);
    const action = (input: unknown) => JSON.parse(queue.action(input, target, new AbortController().signal));
    const saved = action({ action: 'remind', label: 'Check', message: 'Inspect results', deliver,
      ...(series ? { schedule: { frequency: 'interval', interval_minutes: 1, count: 1 } } : { delay_minutes: 1 }) });
    t.mock.timers.setTime(Date.parse(saved.due));
    const before = action({ action: 'list' }), disk = readFileSync(file, 'utf8');
    let executions = 0;
    const run = async (_target: unknown, _message: unknown, admit: () => void) => {
      mkdirSync(file + '.tmp');
      admit();
      executions++;
      return true;
    };
    await assert.rejects(queue.pump({ valid: () => true, deliver: run, post: run, report: () => {} }), { code: 'EISDIR' });
    assert.equal(executions, 0);
    assert.equal(readFileSync(file, 'utf8'), disk);
    rmSync(file + '.tmp', { recursive: true });
    const current = action({ action: 'list' });
    assert.equal(current.length, 1);
    assert.equal(current[0].state, 'waiting');
    assert.equal(current[0].due, before[0].due);
    assert.equal(current[0].remaining, before[0].remaining);
    const retry = async (_target: unknown, _message: unknown, admit: () => void) => { admit(); executions++; return true; };
    await queue.pump({ valid: () => true, deliver: retry, post: retry, report: error => { throw error; } });
    assert.equal(executions, 1);
    assert.deepEqual(action({ action: 'list' }), []);
    const restored = new BackgroundTasks(file, root);
    assert.deepEqual(JSON.parse(restored.action({ action: 'list' }, target, new AbortController().signal)), []);
  });
}
