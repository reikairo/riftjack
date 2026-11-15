import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubReader } from '../src/github-subscriptions.js';
import { errorMessage, PublicError } from '../src/errors.js';
import { hostErrorDetails } from '../src/host-diagnostics.js';

for (const scenario of ['process', 'json'] as const) {
  test(`GitHub ${scenario} failures retain owner diagnostics without exposing provider text publicly`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'github-causes-'));
    const oldPath = process.env.PATH;
    t.after(() => { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });
    const marker = 'private-provider-detail';
    writeFileSync(join(dir, 'gh'), `#!${process.execPath}\n` + (scenario === 'process'
      ? `process.stdout.write('HTTP/2.0 502 Bad Gateway\\n\\n{}'); process.stderr.write('${marker}'); process.exitCode = 1;`
      : `process.stdout.write('HTTP/2.0 200 OK\\n\\n${marker}');`), { mode: 0o700 });
    process.env.PATH = dir + ':' + oldPath;
    const read = githubReader({ ghConfigDir: dir, repositories: ['example/project'] });
    await assert.rejects(read('repos/example/project/pulls/1', AbortSignal.timeout(5000)), error => {
      assert.ok(error instanceof PublicError);
      assert.doesNotMatch(errorMessage(error), /private-provider-detail/);
      assert.ok(error.cause instanceof Error, 'Original failure must survive for the owner');
      const cause = error.cause;
      const details = hostErrorDetails(error);
      assert.ok(details.nodes.some(node => node.message === cause.message && node.stack === cause.stack));
      if (scenario === 'process') {
        assert.match(JSON.stringify(details), /private-provider-detail/);
        assert.equal((error.cause as NodeJS.ErrnoException).code, 1);
      }
      else assert.ok(error.cause instanceof SyntaxError);
      return true;
    });
  });
}
