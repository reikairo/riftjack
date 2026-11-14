import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:net';
import { copyFile, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { outboxDirectory } from '../../src/media.js';
import { embedDiagram } from '../../src/drawio-png.js';
import { diagramDirectory } from '../../src/drawio.js';
import { startBackendTools } from '../../src/backend-tools.js';
import { loadConfig } from '../../src/config.js';
const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: process.cwd() });
const action = async () => '{}';
test('diagram results survive a new turn and outbox cleanup, with paths advertised to the agent', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'diagram-turns-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const xml = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
  const turn = async () => {
    const outbox = await outboxDirectory(root, 'conversation');
    const tools = await startBackendTools({ kind: 'codex', config: { ...config, workspace: root, drawio: { executable: process.execPath } },
      outbox, signal: new AbortController().signal, allowPublication: false });
    t.after(() => tools.close());
    return { outbox, tools };
  };
  const first = await turn();
  assert.ok(first.tools.instructions.includes(JSON.stringify(diagramDirectory(root))));
  const input = join(root, 'received.png'); await writeFile(input, embedDiagram(png, xml));
  const request = async (tools: typeof first.tools, method: string, args: object = {}) => {
    const endpoint = tools.diagram!;
    const result = await (await fetch(endpoint.url, { method: 'POST', headers: { ...endpoint.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { name: 'extract_diagram', arguments: args } }) })).json();
    assert.equal(result.result.isError, undefined, JSON.stringify(result));
    return result.result;
  };
  const listed = await request(first.tools, 'tools/list');
  for (const tool of listed.tools) assert.ok(tool.description.includes(JSON.stringify(diagramDirectory(root))));
  const saved = JSON.parse((await request(first.tools, 'tools/call', { path: input })).content[0].text);
  assert.ok(saved.path.startsWith(diagramDirectory(root) + '/'));
  await copyFile(saved.path, join(first.outbox, 'copy.drawio'));
  await first.tools.close();
  const second = await turn();
  assert.deepEqual(await readdir(second.outbox), []);
  assert.equal(await readFile(saved.path, 'utf8'), xml);
  // A fresh endpoint can still read the original PNG by absolute path.
  const again = JSON.parse((await request(second.tools, 'tools/call', { path: input })).content[0].text);
  assert.notEqual(again.path, saved.path);
  assert.equal(await readFile(again.path, 'utf8'), xml);
});
for (const kind of ['codex', 'claude', 'pi'] as const) test(`${kind} uses the common tool gates and closes every endpoint`, async () => {
  const tools = await startBackendTools({ kind, config: { ...config, sandbox: 'read-only' }, outbox: process.cwd(),
    signal: new AbortController().signal, allowPublication: true, publish: action,
    hooks: { detached: action, confirmation: action, github: action, background: action, releaseNotes: () => '{"markdown":"# Notes"}' } });
  const endpoints = [...tools.connections];
  assert.equal(tools.detached, undefined); assert.equal(tools.publication, undefined);
  assert.ok(tools.github && tools.background && tools.releaseNotes);
  assert.match(tools.instructions, /release_notes/);
  assert.equal(!!tools.confirmation, kind !== 'pi');
  assert.equal(/run_detached/.test(tools.instructions), false);
  try {
    for (const endpoint of endpoints) {
      const response = await fetch(endpoint.url, { method: 'POST', headers: { ...endpoint.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      assert.equal(response.status, 200);
    }
  } finally { await tools.close(); }
  for (const endpoint of endpoints) await assert.rejects(fetch(endpoint.url));
});
test('partial setup failure closes already opened endpoints', async t => {
  let closed = 0;
  const original = Server.prototype.close;
  t.mock.method(Server.prototype, 'close', function(this: Server, ...args: Parameters<Server['close']>) { closed++; return original.apply(this, args); });
  await assert.rejects(startBackendTools({ kind: 'codex', config, outbox: process.cwd(), signal: new AbortController().signal,
    allowPublication: false, hooks: { github: action, get background(): typeof action { throw new Error('fixture setup failure'); } } }), /fixture setup failure/);
  assert.equal(closed, 1);
});
