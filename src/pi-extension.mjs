// Loaded explicitly with discovery disabled. No connector credentials are printed.
export default async function (pi) {
  const config = JSON.parse(process.env.RIFTJACK_PI_BRIDGE || '{}');
  delete process.env.RIFTJACK_PI_BRIDGE;
  const trusted = new Set();
  pi.on('tool_call', async (event, ctx) => {
    if (trusted.has(event.toolName) || ['read', 'grep', 'find', 'ls'].includes(event.toolName)) return;
    if (config.readOnly || config.denyWrites || !['bash', 'write', 'edit'].includes(event.toolName)) {
      return { block: true, reason: 'Tool is disabled by Riftjack.' };
    }
    const details = JSON.stringify(event.input, null, 2);
    if (details.length > 30000 || !ctx.hasUI || !await ctx.ui.confirm(`Allow ${event.toolName}?`, details)) {
      return { block: true, reason: 'This tool call was not approved.' };
    }
  });
  let nextId = 0;
  for (const connection of config.connections || []) {
    const call = async (method, params, signal) => {
      const response = await fetch(connection.url, {
        method: 'POST', headers: { ...connection.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }), signal,
      });
      if (!response.ok) throw new Error('Riftjack tool connection failed.');
      const data = await response.json();
      if (data.error) throw new Error('Riftjack tool request failed.');
      return data.result;
    };
    const listing = await call('tools/list', {}, AbortSignal.timeout(15000));
    for (const tool of listing.tools) {
      const name = `mcp__${connection.name}__${tool.name}`;
      if (trusted.has(name)) throw new Error('Duplicate Riftjack tool.');
      trusted.add(name);
      pi.registerTool({ name, label: tool.name, description: tool.description,
        parameters: tool.inputSchema,
        async execute(_id, input, signal) {
          const result = await call('tools/call', { name: tool.name, arguments: input }, signal);
          if (result.isError) throw new Error(JSON.stringify(result.content));
          return { content: result.content, details: {} };
        },
      });
    }
  }
  pi.on('session_start', (_event, ctx) => {
    pi.setActiveTools([...['read', 'grep', 'find', 'ls'], ...(config.readOnly || config.denyWrites ? [] : ['bash', 'write', 'edit']), ...trusted]);
    // RPC owns stdout. Use its supported UI channel only after tool guards and
    // connections have initialized, before the parent may send a prompt.
    ctx.ui.setStatus('riftjack_ready', config.nonce);
  });
}
