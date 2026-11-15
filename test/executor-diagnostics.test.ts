import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('executor retains request, SDK, invitation and fatal inbox causes with operation and bot context', t => {
  const root = mkdtempSync(join(tmpdir(), 'executor-diagnostics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), data = join(root, 'data'), policy = join(root, 'policy.json');
  mkdirSync(workspace);
  writeFileSync(policy, JSON.stringify({ workspace, mode: 'limited', senders: ['@alice:example.com'], rooms: ['!home:example.com'] }));
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { executorMain } from './src/executor-main.ts';
    import { MessageMatrixClient } from './src/message-matrix-client.ts';
    import { LogService } from '@vector-im/matrix-bot-sdk';
    const failure = operation => Object.assign(new Error('original ' + operation + ' failure'), { code: 'EIO' });
    MessageMatrixClient.prototype.requestOnce = async function () { throw failure('request'); };
    MessageMatrixClient.prototype.joinRoom = async function () { throw failure('join'); };
    MessageMatrixClient.prototype.getWhoAmI = async function () {
      try { await this.doRequest('GET', '/_matrix/client/v3/sync'); } catch {}
      LogService.error('MatrixClientLite', failure('sdk'));
      this.emit('room.invite', '!home:example.com', { sender: '@alice:example.com' });
      await new Promise(resolve => setImmediate(resolve));
      this.emit('worker.inbox_failure', failure('inbox'));
      throw new Error('Fatal inbox handler must terminate the executor');
    };
    await executorMain();
  `], { encoding: 'utf8', timeout: 10000, env: { ...process.env,
    EXECUTOR_POLICY: policy, EXECUTOR_DATA_DIR: data, MATRIX_HOMESERVER: 'https://matrix.example.com',
    MATRIX_ACCESS_TOKEN: 'synthetic-private-token', MATRIX_USER_ID: '@executor:example.com',
  } });
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 1, child.stderr);
  assert.doesNotMatch(child.stderr, /original (request|sdk|join|inbox) failure|synthetic-private-token/);
  const records = readFileSync(join(data, 'diagnostics', 'errors.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const [operation, marker] of [['matrix.request', 'request'], ['matrix.sdk.client', 'sdk'], ['executor.join', 'join'], ['executor.inbox_failure', 'inbox']]) {
    const record = records.find(record => record.operation === operation);
    assert.ok(record, operation);
    assert.equal(record.ownerContext.bot, '@executor:example.com');
    if (marker === 'request') { assert.equal(record.endpoint, 'sync'); assert.equal(record.method, 'GET'); assert.equal(record.attempt, 1); }
    assert.match(JSON.stringify(record.errorDetails), new RegExp('original ' + marker + ' failure'));
  }
});
