import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startToolMcp } from '../../src/tool-mcp.js';
import { PublicError } from '../../src/errors.js';

test('MCP preserves safe causes while keeping cancellation distinct from failure', async t => {
  const lifetime = new AbortController();
  let started!: () => void;
  const admitted = new Promise<void>(resolve => { started = resolve; });
  const server = await startToolMcp({ name: 'probe', description: 'fixture', inputSchema: {}, annotations: {} }, async (input, signal) => {
    const failure = Object.assign(new Error('Authorization: secret; private body'), { code: 'EACCES', syscall: 'open' });
    if (input === 'wrapped') throw new PublicError('Operation failed.', { cause: failure });
    if (input === 'cancel') { started(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    throw failure;
  }, lifetime.signal, { server: 'fixture', failed: 'Tool operation failed', cancelled: 'Request cancelled; no decision was recorded.' });
  t.after(() => server.close());
  const rpc = async (body: object) => {
    const response = await fetch(server.url, { method: 'POST', headers: { ...server.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', ...body }) });
    return response.status === 202 ? undefined : response.json();
  };
  for (const [id, input] of ['plain', 'wrapped'].entries()) {
    const result = (await rpc({ id, method: 'tools/call', params: { name: 'probe', arguments: input } })).result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /EACCES.*open/);
    assert.doesNotMatch(result.content[0].text, /secret|private body|Authorization/);
  }
  const pending = rpc({ id: 3, method: 'tools/call', params: { name: 'probe', arguments: 'cancel' } });
  await admitted;
  await rpc({ method: 'notifications/cancelled', params: { requestId: 3 } });
  assert.equal((await pending).result.content[0].text, 'Request cancelled; no decision was recorded.');
});
