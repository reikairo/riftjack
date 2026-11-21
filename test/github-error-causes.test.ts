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

test('GitHub reports its own request deadline separately from a gh process terminated by SIGTERM', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'github-timeout-'));
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
if (process.argv.at(-1).endsWith('/slow')) setInterval(() => {}, 1000);
else process.kill(process.pid, 'SIGTERM');
`, { mode: 0o700 });
  process.env.PATH = dir + ':' + oldPath;

  const read = githubReader({ ghConfigDir: dir, repositories: ['example/project'] });
  const signal = new AbortController().signal;
  const shortDeadline = AbortSignal.timeout.bind(AbortSignal);
  const clock = t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, 30_000);
    return shortDeadline(50);
  });
  await assert.rejects(read('repos/example/project/slow', signal), error => {
    assert.ok(error instanceof PublicError);
    assert.match(errorMessage(error), /timed out after 30 seconds/);
    assert.doesNotMatch(errorMessage(error), /authentication/i);
    return true;
  });

  clock.mock.restore();
  await assert.rejects(read('repos/example/project/interrupted', signal), error => {
    assert.ok(error instanceof PublicError);
    assert.match(errorMessage(error), /SIGTERM/);
    assert.doesNotMatch(errorMessage(error), /timed out/i);
    return true;
  });
});

for (const reason of ['dial tcp 192.0.2.1:443: connect: operation timed out', 'dial tcp 192.0.2.1:443: i/o timeout',
  'dial tcp 192.0.2.1:443: connect: connection refused', 'net/http: TLS handshake timeout']) {
  test(`GitHub transport diagnostic: ${reason}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'github-dial-'));
    const oldPath = process.env.PATH;
    t.after(() => { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });
    const diagnostic = `Get "https://api.github.com/repos/example/private-project/pulls/1/reviews?per_page=100&page=1": ${reason}`;
    writeFileSync(join(dir, 'gh'), `#!${process.execPath}\nconsole.error(${JSON.stringify(diagnostic)}); process.exitCode = 1;`, { mode: 0o700 });
    process.env.PATH = dir + ':' + oldPath;
    const read = githubReader({ ghConfigDir: dir, repositories: ['example/project'] });
    await assert.rejects(read('repos/example/private-project/pulls/1/reviews?per_page=100&page=1', AbortSignal.timeout(5000)), error => {
      assert.ok(error instanceof PublicError);
      const message = errorMessage(error);
      if (reason.endsWith('refused')) assert.doesNotMatch(message, /timed out/);
      else if (reason.includes('TLS handshake')) assert.match(message, /TLS handshake with the GitHub API timed out/i);
      else assert.match(message, /connection to the GitHub API timed out/i);
      assert.doesNotMatch(message, /192\.0\.2\.1|private-project|30 seconds/);
      assert.ok(error.cause instanceof Error && error.cause.message.includes(diagnostic));
      return true;
    });
  });
}
