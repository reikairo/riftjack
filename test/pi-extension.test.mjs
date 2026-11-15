import test from 'node:test';
import assert from 'node:assert/strict';
import extension from '../src/pi-extension.mjs';

for (const policy of [{}, { readOnly: true }, { denyWrites: true }]) {
  test(`Pi extension announces readiness after installing guards: ${JSON.stringify(policy)}`, async () => {
    const previous = process.env.RIFTJACK_PI_BRIDGE;
    process.env.RIFTJACK_PI_BRIDGE = JSON.stringify({ nonce: 'test-nonce', connections: [], ...policy });
    try {
      const handlers = new Map(); let active; const statuses = [];
      await extension({ on: (name, fn) => handlers.set(name, fn), setActiveTools: tools => { active = tools; } });
      assert.equal(process.env.RIFTJACK_PI_BRIDGE, undefined);
      assert.equal(statuses.length, 0);
      assert.ok(handlers.has('tool_call'));
      handlers.get('session_start')({}, { ui: { setStatus: (...args) => statuses.push(args) } });
      assert.deepEqual(statuses, [['riftjack_ready', 'test-nonce']]);
      const call = handlers.get('tool_call');
      assert.equal(await call({ toolName: 'read' }, {}), undefined);
      assert.equal((await call({ toolName: 'unknown' }, {})).block, true);
      let asked = 0;
      const ctx = { hasUI: true, ui: { confirm: async () => { asked++; return true; } } };
      const result = await call({ toolName: 'bash', input: { command: 'true' } }, ctx);
      if (policy.readOnly || policy.denyWrites) {
        assert.equal(result.block, true); assert.equal(asked, 0); assert.ok(!active.includes('bash'));
      } else {
        assert.equal(result, undefined); assert.equal(asked, 1); assert.ok(active.includes('bash'));
        assert.equal((await call({ toolName: 'write', input: {} }, { hasUI: false })).block, true);
        assert.equal((await call({ toolName: 'edit', input: {} }, { hasUI: true, ui: { confirm: async () => false } })).block, true);
      }
    } finally {
      if (previous === undefined) delete process.env.RIFTJACK_PI_BRIDGE;
      else process.env.RIFTJACK_PI_BRIDGE = previous;
    }
  });
}

for (const phase of ['listing', 'execution']) for (const kind of ['http', 'rpc']) {
  test(`Pi ${phase} reports the ${kind} status without response text`, async t => {
    const previous = process.env.RIFTJACK_PI_BRIDGE;
    process.env.RIFTJACK_PI_BRIDGE = JSON.stringify({ nonce: 'test', connections: [
      { name: 'service', url: 'http://127.0.0.1:1/mcp', headers: {} },
    ] });
    t.after(() => {
      if (previous === undefined) delete process.env.RIFTJACK_PI_BRIDGE;
      else process.env.RIFTJACK_PI_BRIDGE = previous;
    });
    t.mock.method(globalThis, 'fetch', async (_url, request) => {
      const { method } = JSON.parse(request.body);
      if (phase === 'execution' && method === 'tools/list') return Response.json({ result: { tools: [
        { name: 'inspect', description: 'Inspect', inputSchema: { type: 'object' } },
      ] } });
      return kind === 'http' ? new Response('private service body', { status: 503 })
        : Response.json({ error: { code: -32602, message: 'private service message', data: { private: true } } });
    });
    let registered;
    const load = () => extension({ on: () => {}, registerTool: tool => { registered = tool; } });
    const run = phase === 'listing' ? load : async () => {
      await load();
      return registered.execute('id', {}, new AbortController().signal);
    };
    await assert.rejects(run(), error => {
      assert.match(error.message, kind === 'http' ? /HTTP 503/ : /JSON-RPC -32602/);
      assert.equal(kind === 'http' ? error.status : error.code, kind === 'http' ? 503 : -32602);
      assert.doesNotMatch(error.message, /private service/);
      return true;
    });
  });
}
