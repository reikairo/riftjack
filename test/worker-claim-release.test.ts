import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerQueue } from '../src/worker-queue.js';
import { WorkerService } from '../src/worker-service.js';

for (const stage of ['authorization', 'prompt', 'aborted request'] as const) {
  test(`failed claim ${stage} releases the undisclosed lease for immediate retry`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'worker-claim-'));
    const queue = new WorkerQueue(join(root, 'queue.sqlite'), () => 1000);
    t.after(() => { queue.close(); rmSync(root, { recursive: true, force: true }); });
    const task = queue.enqueue('!room:example.com', { event_id: '$one', sender: '@alice:example.com',
      content: { msgtype: 'm.text', body: 'Continue' } }, 'conversation');
    const failure = Object.assign(new Error('claim preparation failed'), { code: 'ETIMEDOUT' });
    const controller = new AbortController();
    let checks = 0, fail = true;
    const service = new WorkerService(queue, join(root, 'files'), 100, {
      allowed: async () => {
        if (++checks === 2 && fail) {
          if (stage === 'authorization') throw failure;
          if (stage === 'aborted request') controller.abort(failure);
        }
        return true;
      },
      prompt: () => { if (stage === 'prompt' && fail) throw failure; return 'Continue'; },
      receive: async () => undefined, prepare: async () => [], send: async () => {}, report: () => {},
    });
    t.after(() => service.stop());
    await assert.rejects(service.claim(controller.signal), error => error === failure);
    assert.equal(queue.get(task.id).status, 'queued');
    assert.equal(queue.get(task.id).lease, undefined);
    fail = false;
    const retried = await service.claim();
    assert.equal(retried?.id, task.id);
    assert.equal(retried?.attempt, 2);
    assert.ok(retried?.lease);
  });
}

for (const outcome of ['cancelled', 'replaced'] as const) {
  test(`failed claim cleanup preserves a task ${outcome} during authorization`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'worker-claim-'));
    let now = 1000;
    const queue = new WorkerQueue(join(root, 'queue.sqlite'), () => now, 100);
    t.after(() => { queue.close(); rmSync(root, { recursive: true, force: true }); });
    const task = queue.enqueue('!room:example.com', { event_id: '$one' }, 'conversation');
    const failure = new Error('authorization failed');
    let checks = 0, replacement: string | undefined;
    const service = new WorkerService(queue, join(root, 'files'), 100, {
      allowed: async () => {
        if (++checks === 2) {
          if (outcome === 'cancelled') queue.cancel(task.id);
          else { now += 101; replacement = queue.claim(task.id)!.lease; }
          throw failure;
        }
        return true;
      },
      receive: async () => undefined, prepare: async () => [], send: async () => {}, report: () => {},
    });
    t.after(() => service.stop());
    await assert.rejects(service.claim(), error => error === failure);
    const current = queue.get(task.id);
    assert.equal(current.status, outcome === 'cancelled' ? 'cancelled' : 'leased');
    if (outcome === 'replaced') assert.equal(current.lease, replacement);
  });
}
