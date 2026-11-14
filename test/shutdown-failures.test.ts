import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const component of ['none', 'bridge', 'client', 'worker']) {
  test(`shutdown cleans up every component after ${component} failure`, t => {
    const root = mkdtempSync(join(tmpdir(), 'riftjack-shutdown-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data/accounts.json'), JSON.stringify(['one', 'two'].map(name => ({
      userId: `@${name}:test`, accessToken: 'test-token', kind: 'manager', name, roomId: `!${name}:test`,
    }))));
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'),
      '--import', new URL('./fixtures/shutdown-failures.ts', import.meta.url).href,
      fileURLToPath(new URL('../src/main.ts', import.meta.url))], {
      cwd: root, encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL',
      env: { PATH: process.env.PATH, HOME: root, MATRIX_HOMESERVER: 'https://matrix.test',
        MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: root, DATA_DIR: join(root, 'data'),
        WORKER_PORT: '8788', TEST_STOP_FAILURE: component },
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.ok(existsSync(join(root, 'lifecycle')), result.stderr + result.stdout);
    const events = readFileSync(join(root, 'lifecycle'), 'utf8').trim().split('\n');
    assert.equal(events.filter(e => e === 'bridge-stop').length, 2, result.stderr);
    assert.equal(events.filter(e => e === 'client-stop').length, 2, result.stderr);
    assert.equal(events.filter(e => e === 'worker-stop').length, 1, result.stderr);
    assert.equal(result.status, component === 'none' ? 0 : 1, result.stderr);
    if (component !== 'none') {
      assert.match(result.stderr, new RegExp(`Could not stop ${component}`));
      assert.match(result.stderr, /EIO/);
    }
  });
}
