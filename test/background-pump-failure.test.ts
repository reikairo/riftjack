import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('scan and delivery persistence failures both reach the pump caller without an unhandled rejection', async () => {
  // Use a separate process so Node's unhandled-rejection policy is exercised.
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { BackgroundTasks } from ${JSON.stringify(new URL('../src/background-tasks.ts', import.meta.url).href)};
    import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    const root = mkdtempSync(join(tmpdir(), 'background-pump-failure-'));
    try {
      const file = join(root, 'watches.json');
      const queue = new BackgroundTasks(file, root);
      writeFileSync(join(root, 'status.json'), JSON.stringify({ state: 'done' }));
      for (const room of ['!first:example.com', '!second:example.com']) {
        queue.action({ action: 'watch', label: 'Build', status_file: 'status.json', field: 'state', terminal: ['done'] },
          { room, sender: '@alice:example.com', key: room, session: 'session' }, new AbortController().signal);
      }
      // The first watch schedules delivery; cancelling the second fails during
      // the scan. The scheduled delivery then fails to save its own snapshot.
      mkdirSync(file + '.tmp');
      let caught;
      try {
        await queue.pump({ valid: target => target.room === '!first:example.com',
          deliver: async () => { throw new Error('Delivery must not start without a saved snapshot'); }, report: () => {} });
      } catch (error) { caught = error; }
      await new Promise(resolve => setImmediate(resolve));
      console.log(JSON.stringify({ aggregate: caught instanceof AggregateError,
        codes: (caught?.errors ?? [caught]).map(error => error?.code) }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { aggregate: true, codes: ['EISDIR', 'EISDIR'] });
});
