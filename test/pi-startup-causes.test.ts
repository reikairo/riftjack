import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPi, createPiBackend } from '../src/pi-backend.js';
import { loadConfig } from '../src/config.js';
import { State } from '../src/state.js';
import { errorMessage } from '../src/errors.js';
import { hostErrorDetails } from '../src/host-diagnostics.js';

for (const stage of ['missing', 'version', 'spawn'] as const) test(`Pi ${stage} failure preserves the process cause`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-startup-causes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, 'pi');
  if (stage !== 'missing') writeFileSync(cli, `#!${process.execPath}
if (process.argv.includes('--version')) {
  ${stage === 'version' ? "console.error('Private version failure'); process.exit(7);" : "require('node:fs').unlinkSync(__filename); console.log('1.4.0'); process.exit(0);"}
}
process.exit(9);
`, { mode: 0o700 });
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test',
    RIFTJACK_WORKSPACE: root, DATA_DIR: join(root, 'data'), PI_PATH: cli });
  const signal = AbortSignal.timeout(5000);
  const action = stage === 'spawn'
    ? createPiBackend(config, new State(join(root, 'state.json')))('pi', 'Task', 'key', signal, config.owner)
    : checkPi(config, signal);
  await assert.rejects(action, error => {
    assert.ok(error instanceof Error);
    const cause = error.cause as NodeJS.ErrnoException | undefined;
    assert.ok(cause);
    assert.equal(cause.code, stage === 'version' ? 7 : 'ENOENT');
    assert.ok(hostErrorDetails(error).nodes.some(node => node.message === cause.message && node.stack === cause.stack));
    assert.doesNotMatch(errorMessage(error), /Private version failure/);
    assert.ok(!errorMessage(error).includes(root));
    return true;
  });
});

test('Pi readiness cancellation retains the caller reason', async () => {
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test',
    RIFTJACK_WORKSPACE: process.cwd(), PI_PATH: '/nonexistent/pi' });
  const reason = new Error('cancel fixture');
  await assert.rejects(checkPi(config, AbortSignal.abort(reason)), error => error === reason);
});
