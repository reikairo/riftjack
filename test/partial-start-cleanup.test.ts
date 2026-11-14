import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const stopFails of [false, true]) {
  test(`failed bot startup stops recovery and preserves original error (cleanup fails=${stopFails})`, t => {
    const root = mkdtempSync(join(tmpdir(), 'riftjack-partial-start-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data/accounts.json'), JSON.stringify([
      { userId: '@failed:test', accessToken: 'test-token', kind: 'codex', name: 'Failed', roomId: '!failed:test' },
      { userId: '@healthy:test', accessToken: 'test-token', kind: 'manager', name: 'Healthy', roomId: '!healthy:test' },
    ]));
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'),
      '--import', new URL('./fixtures/partial-start-cleanup.ts', import.meta.url).href,
      fileURLToPath(new URL('../src/main.ts', import.meta.url))], {
      cwd: root, encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL',
      env: { PATH: process.env.PATH, HOME: root, MATRIX_HOMESERVER: 'https://matrix.test',
        MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: root, DATA_DIR: join(root, 'data'),
        WORKER_PORT: '8788', TEST_STOP_FAILURE: stopFails ? '1' : '0' },
    });
    assert.equal(result.error, undefined, result.stderr);
    const events = readFileSync(join(root, 'lifecycle'), 'utf8').trim().split('\n');
    assert.equal(events.filter(e => e === 'recovery-stop').length, 1, JSON.stringify(events));
    assert.ok(events.indexOf('recovery-stop') < events.indexOf('healthy-start'));
    assert.ok(events.includes('recovery-active:0'));
    assert.equal(events.filter(e => e === 'client-stop:@failed:test').length, 1);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /ENETUNREACH/);
    if (stopFails) assert.match(result.stderr, /EIO/);
  });
}
