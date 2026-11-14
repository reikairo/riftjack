import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { State } from '../../src/state.js';
import { loadConfig } from '../../src/config.js';
import { createBackend } from '../../src/backends.js';
import { Bridge, type MatrixEvent } from '../../src/bridge.js';
import { startReleaseNotesMcp } from '../../src/release-notes-mcp.js';

for (const kind of ['codex', 'claude', 'pi'] as const) test(`${kind} reads the startup notes through its configured MCP tool in a read-only workspace`, { timeout: 20_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-notes-mcp-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, 'cli.cjs');
  writeFileSync(cli, `#!/usr/bin/env node
const args=process.argv.slice(2);
const send=v=>console.log(JSON.stringify(v));
if (args.includes('--help')) { console.log('--input-format --output-format --permission-mode --permission-prompt-tool --append-system-prompt --tools --settings --resume'); process.exit(); }
if (args[0]==='auth') { send({loggedIn:true,authMethod:'claude.ai'}); process.exit(); }
let connection;
if (args.includes('--version')) { console.log('1.4.0'); process.exit(); }
const pi = process.env.RIFTJACK_PI_BRIDGE && JSON.parse(process.env.RIFTJACK_PI_BRIDGE);
if (pi) {
  connection = pi.connections.find(c => c.name === 'riftjack_release_notes');
  send({type:'extension_ui_request',method:'setStatus',statusKey:'riftjack_ready',statusText:pi.nonce});
}
async function work() {
  const response=await fetch(connection.url,{method:'POST',headers:{...connection.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'release_notes',arguments:{}}})});
  const message=await response.json();
  if (message.result.isError) throw Error(message.result.content[0].text);
  return message.result.content[0].text;
}
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 try {
  const message=JSON.parse(line);
  if (pi) {
    if (message.type === 'get_state') send({type:'response',id:message.id,success:true,data:{sessionId:args[args.indexOf('--session-id')+1],model:{id:'fixture'}}});
    if (message.type === 'prompt') {
      send({type:'response',id:message.id,success:true});
      const text = await work();
      send({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}});
      send({type:'agent_settled'});
    }
    return;
  }
  if (args.includes('--mcp-config')) {
    connection=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.riftjack_release_notes;
    if (!args[args.indexOf('--allowedTools')+1].includes('mcp__riftjack_release_notes__release_notes')) throw Error('Tool not allowed');
    send({type:'system',subtype:'init',session_id:'notes-session'});
    const result=await work();
    send({type:'result',subtype:'success',result,session_id:'notes-session'});
    return;
  }
  const {id,method,params:p}=message;
  const reply=result=>send({id,result});
  if (method==='initialize') reply({});
  if (method==='account/read') reply({account:{type:'chatgpt'}});
  if (method==='thread/start'||method==='thread/resume') {
    const c=p.config['mcp_servers.riftjack_release_notes'];
    if (!c.enabled_tools.includes('release_notes')||c.tools.release_notes.approval_mode!=='approve') throw Error('Tool policy');
    connection={url:c.url,headers:c.http_headers};
    reply({thread:{id:'notes-session'}});
  }
  if (method==='thread/inject_items') reply({});
  if (method==='turn/start') {
    reply({turn:{id:'turn-1',status:'inProgress'}});
    const text=await work();
    send({method:'turn/completed',params:{threadId:'notes-session',turn:{id:'turn-1',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text}]}}});
  }
 } catch(error) { console.error(error); process.exit(2); }
});
`, { mode: 0o700 });
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@alice:test', RIFTJACK_WORKSPACE: root, CODEX_PATH: cli, CLAUDE_PATH: cli, PI_PATH: cli, DATA_DIR: join(root, 'data'), CODEX_SANDBOX: 'read-only' });
  const state = new State(join(root, 'sessions.json')), backend = createBackend(config, state);
  const room = '!room:test';
  const event: MatrixEvent = { type: 'm.room.message', sender: '@alice:test', event_id: '$request', origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: 'Read the release notes.', 'm.relates_to': { rel_type: 'm.thread', event_id: '$thread' } } };
  const replies: string[] = [];
  const bridge = new Bridge({ botId: '@bot:test', kind, since: 0, timeoutMs: 10_000, state,
    isAuthorized: () => true, isPrivateRoom: async () => true, run: backend,
    reply: async (_room, _event, text) => { replies.push(text); }, report: () => {},
    releaseNotes: () => JSON.stringify({ revision: '1'.repeat(40), markdown: '# Running version' }),
  });
  await bridge.handle(room, event);
  assert.deepEqual(JSON.parse(replies.at(-1)!), { revision: '1'.repeat(40), markdown: '# Running version' });
});

test('release notes MCP requires its token, accepts no parameters and closes on cancellation', async () => {
  const controller = new AbortController();
  const server = await startReleaseNotesMcp(() => '{"markdown":"# Notes"}', controller.signal);
  let id = 0;
  try {
    const rpc = async (args: unknown, headers = server.headers) => fetch(server.url, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id,
        method: 'tools/call', params: { name: 'release_notes', arguments: args } }) });
    assert.equal((await rpc({}, {} as typeof server.headers)).status, 401);
    for (const args of [{}, undefined]) assert.equal(JSON.parse((await (await rpc(args)).json()).result.content[0].text).markdown, '# Notes');
    for (const args of [{ path: '/etc/passwd' }, [], null]) assert.equal((await (await rpc(args)).json()).result.isError, true);
  } finally { controller.abort(); await server.close(); }
  await assert.rejects(fetch(server.url));
});
