import test from 'node:test';
import assert from 'node:assert/strict';
import { startBackgroundMcp } from '../../src/background-mcp.js';
import { startGitHubMcp } from '../../src/github-mcp.js';
import { startDetachedMcp } from '../../src/detached-mcp.js';
import { startConfirmationMcp } from '../../src/confirmation-mcp.js';
import { startPublishMcp } from '../../src/publish-mcp.js';
import { Bridge } from '../../src/bridge.js';
import { linkedToolConversation } from '../../src/tool-conversation.js';
import { bot, owner, home, shared, signal, event, target, homeTarget, linkedToolsFixture } from '../fixtures/linked-tools.js';

const endpoints = [
  { name: 'background_tasks', start: startBackgroundMcp, request: { action: 'list' } },
  { name: 'github_subscriptions', start: startGitHubMcp, request: { action: 'list' } },
  { name: 'run_detached', start: startDetachedMcp, request: { action: 'list' } },
  { name: 'request_confirmation', start: startConfirmationMcp, request: { question: 'Proceed?' } },
  { name: 'prepare_publish', start: startPublishMcp, request: { repository: 'projects/demo', remote: 'origin', branch: 'topic' } },
];
function rpcClient(server: { url: string; headers: { Authorization: string } }) {
  let id = 0;
  return async (method: string, params?: object) => (await (await fetch(server.url, { method: 'POST',
    headers: { ...server.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json());
}

for (const endpoint of endpoints) test(`${endpoint.name} advertises and forwards an explicit conversation through MCP`, async t => {
  const requests: unknown[] = [];
  const server = await endpoint.start(async request => { requests.push(request); return 'accepted'; }, signal());
  t.after(() => server.close());
  const rpc = rpcClient(server);
  const tools = await rpc('tools/list');
  const selector = tools.result.tools[0].inputSchema.properties.conversation;
  assert.equal(selector.additionalProperties, false); assert.deepEqual(selector.required, ['room']);
  const input = { ...endpoint.request, conversation: { room: home, thread: null } };
  const response = await rpc('tools/call', { name: endpoint.name, arguments: input });
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content[0].text, 'accepted');
  assert.deepEqual(requests, [input]);
  if (endpoint.name === 'prepare_publish') {
    const forged = await rpc('tools/call', { name: endpoint.name,
      arguments: { ...endpoint.request, conversation: { room: home, owner } } });
    assert.equal(forged.result.isError, true); assert.equal(requests.length, 1);
    const invalid = await rpc('tools/call', { name: endpoint.name, arguments: { ...input, arbitrary: 'extra' } });
    assert.equal(invalid.result.isError, true); assert.equal(requests.length, 1);
  }
});

test('MCP to bridge to persistent timer can manage the original home timer from a shared turn', async t => {
  const f = linkedToolsFixture(t);
  const timer = JSON.parse(f.background.action({ action: 'remind', label: 'Check notes', message: 'Review notes.',
    delay_minutes: 10, deliver: 'agent' }, homeTarget, signal()));
  const bridge = new Bridge({ botId: bot, owner, kind: 'codex', since: 0, state: f.state, timeoutMs: 5000,
    linkedSession: (room, e) => f.links.key(bot, room, e), isAuthorized: s => s === owner, isPrivateRoom: async () => true,
    toolConversation: (selection, source, s) => linkedToolConversation(f.links, bot, source, selection, s,
      { allowed: async () => true, stopping: () => false }),
    background: async (input, context, s) => f.background.action(input, target(context), s),
    report: e => { throw e; }, reply: async () => {},
    run: async (_mode, _prompt, _key, s, _sender, _files, _interact, _publish, hooks) => {
      const server = await startBackgroundMcp(hooks!.background!, s);
      try {
        const rpc = rpcClient(server);
        const call = async (args: object) => (await rpc('tools/call', { name: 'background_tasks', arguments: args })).result;
        assert.deepEqual(JSON.parse((await call({ action: 'list' })).content[0].text), []);
        const listed = await call({ action: 'list', conversation: { room: home } });
        assert.equal(JSON.parse(listed.content[0].text)[0].id, timer.id);
        const cancelled = await call({ action: 'cancel', id: timer.id, conversation: { room: home } });
        assert.equal(JSON.parse(cancelled.content[0].text).state, 'cancelled');
      } finally { await server.close(); }
      return 'Done';
    },
  });
  t.after(() => bridge.stop());
  await bridge.handle(shared, event());
  assert.deepEqual(JSON.parse(f.background.action({ action: 'list' }, homeTarget, signal())), []);
});
