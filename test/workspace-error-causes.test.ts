import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { creationWorkspace, resolveWorkspace } from '../src/workspace.js';
import { errorMessage } from '../src/errors.js';
import { hostErrorDetails } from '../src/host-diagnostics.js';

for (const stage of ['resolve', 'inspect', 'create'] as const) test(`workspace ${stage} failure retains filesystem evidence`, {
  skip: process.platform === 'win32' || (stage === 'create' && process.getuid?.() === 0),
}, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-causes-')));
  t.after(() => { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); });
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: root });
  const path = join(root, stage === 'inspect' ? 'loop' : 'new-folder');
  if (stage === 'inspect') symlinkSync(path, path);
  if (stage === 'create') chmodSync(root, 0o500);
  let confirmations = 0;
  const verify = (error: unknown) => {
    assert.ok(error instanceof Error);
    const expected = stage === 'resolve' ? 'ENOENT' : stage === 'inspect' ? 'ELOOP' : 'EACCES';
    assert.equal((error.cause as NodeJS.ErrnoException)?.code, expected);
    assert.ok(hostErrorDetails(error).nodes.some(node => node.code === expected && String(node.stack).includes(root)));
    assert.ok(errorMessage(error).includes(expected));
    assert.ok(!errorMessage(error).includes(root));
    return true;
  };
  if (stage === 'resolve') assert.throws(() => resolveWorkspace(path, root), verify);
  else await assert.rejects(creationWorkspace(config, path, config.owner, async request => {
    confirmations++;
    return request.approve!;
  }, new AbortController().signal), verify);
  assert.equal(confirmations, stage === 'create' ? 1 : 0);
  assert.equal(existsSync(join(root, 'new-folder')), false);
});
