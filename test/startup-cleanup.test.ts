import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('fatal worker listener startup failure stops already-running bots and exits', t => {
  const root = mkdtempSync(join(tmpdir(), 'riftjack-startup-cleanup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data/accounts.json'), JSON.stringify([
    { userId: '@manager:test', accessToken: 'test-token', kind: 'manager', name: 'Manager', roomId: '!room:test' },
  ]));
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'),
    '--import', new URL('./fixtures/startup-cleanup.ts', import.meta.url).href,
    fileURLToPath(new URL('../src/main.ts', import.meta.url))], {
    cwd: root, encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL',
    env: { PATH: process.env.PATH, HOME: root, MATRIX_HOMESERVER: 'https://matrix.test',
      MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: root, DATA_DIR: join(root, 'data'), WORKER_PORT: '8788' },
  });
  const events = readFileSync(join(root, 'lifecycle'), 'utf8').trim().split('\n');
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(events, ['client-start', 'listener-failure', 'bridge-stop', 'client-stop', 'worker-stop']);
  assert.match(result.stderr, /EADDRINUSE/);
});
