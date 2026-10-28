import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../../src/backends.js';
import { loadConfig } from '../../src/config.js';
import { State } from '../../src/state.js';
import { Interactions } from '../../src/interactions.js';
import { DetachedRuns } from '../../src/detached-runs.js';
for (const kind of ['codex', 'claude'] as const) test(`${kind} exposes detached MCP and stages a reviewed launch without direct execution`, { timeout: 20_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'detached-backend-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, 'cli.cjs');
  writeFileSync(cli, `#!/usr/bin/env node
const args=process.argv.slice(2), send=v=>console.log(JSON.stringify(v));
if(args.includes('--help')) { console.log('--input-format --output-format --permission-mode --permission-prompt-tool --append-system-prompt --tools --settings --resume'); process.exit(); }
if(args[0]==='auth') { send({loggedIn:true,authMethod:'claude.ai'}); process.exit(); }
let connection;
async function work(){
 const r=await fetch(connection.url,{method:'POST',headers:{...connection.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'run_detached',arguments:{action:'start',label:'fixture',cwd:process.cwd(),argv:[process.execPath,'-e','console.log(1)']}}})});
 const m=await r.json(); if(m.result.isError) throw Error(m.result.content[0].text);
 return JSON.parse(m.result.content[0].text).status;
}
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 try{
 const message=JSON.parse(line);
 if(args.includes('--mcp-config')){
  connection=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.riftjack_detached;
  if(!args[args.indexOf('--allowedTools')+1].includes('mcp__riftjack_detached__run_detached')) throw Error('Missing tool');
  send({type:'system',subtype:'init',session_id:'detached-session'});
  send({type:'result',subtype:'success',result:await work(),session_id:'detached-session'}); return;
 }
 const {id,method,params:p}=message, reply=result=>send({id,result});
 if(method==='initialize') reply({});
 if(method==='account/read') reply({account:{type:'chatgpt'}});
 if(method==='thread/start'||method==='thread/resume'){
  const c=p.config['mcp_servers.riftjack_detached'];
  if(c.tools.run_detached.approval_mode!=='approve') throw Error('Unexpected second approval');
  connection={url:c.url,headers:c.http_headers}; reply({thread:{id:'detached-session'}});
 }
 if(method==='turn/start'){
  reply({turn:{id:'turn-1',status:'inProgress'}});
  send({method:'turn/completed',params:{threadId:'detached-session',turn:{id:'turn-1',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text:await work()}]}}});
 }
 }catch(error){console.error(error);process.exit(2);}
});
`, { mode: 0o700 });
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@alice:test', RIFTJACK_WORKSPACE: root, CODEX_PATH: cli, CLAUDE_PATH: cli });
  const state = new State(join(root, 'sessions.json')), backend = createBackend(config, state);
  const interactions = new Interactions(); let count = 0;
  const interact = (request: import('../../src/interactions.js').Interaction, signal: AbortSignal) => interactions.ask(request, signal, async (text, controls) => {
      count++; assert.ok(text.includes('Detached command')); controls.bind('$confirmation');
      interactions.react('$confirmation', '✅');
    });
  const manager = new DetachedRuns(join(root, 'runs'), root, { notify() {} });
  const result = await backend(kind, 'Ask before starting.', 'key', new AbortController().signal, '@alice:test', [],
    interact, undefined, { detached: (input, signal) => manager.action(input, { key: 'key', room: '!room:test', sender: '@alice:test', session: 'detached-session' }, signal, interact, async () => {}) });
  assert.equal(result, 'prepared'); assert.equal(count, 1); assert.equal(interactions.size, 0);
});


test('detached MCP exposes confirmed closure and preserves lost status', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'detached-close-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { startDetachedMcp } = await import('../../src/detached-mcp.js');
  const { save } = await import('../../scripts/detached-runner.mjs');
  const target = { key: 'key', room: '!room:test', sender: '@alice:test', session: 'session' };
  const lifetime = new AbortController();
  const hooks = { processTable: () => [], notify() {} };
  const directory = join(root, 'runs');
  let manager = new DetachedRuns(directory, root, hooks);
  const run = JSON.parse(await manager.action({ action: 'start', label: 'fixture', cwd: root,
    argv: [process.execPath, '-e', 'process.exit(0)'] }, target, lifetime.signal, async r => r.approve!, async () => {}));
  const index = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8'));
  index.runs[0].launchBy = Date.now() - 1; save(join(directory, 'index.json'), index);
  save(join(directory, run.id, 'status.json'), { id: run.id, status: 'lost', reason: 'supervisor_failed' });
  manager = new DetachedRuns(directory, root, hooks);
  let approvals = 0;
  const server = await startDetachedMcp((input, signal) => manager.action(input, target, signal,
    async r => { approvals++; return r.approve!; }, async () => {}), lifetime.signal);
  t.after(() => server.close()); let id = 0;
  const rpc = async (method: string, params?: object) => (await (await fetch(server.url, { method: 'POST',
    headers: { ...server.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json());
  const schema = (await rpc('tools/list')).result.tools[0].inputSchema.properties;
  assert.ok(schema.action.enum.includes('close')); assert.equal(schema.evidence.maxLength, 2000);
  const invalid = await rpc('tools/call', { name: 'run_detached', arguments: { action: 'close', id: run.id } });
  assert.ok(invalid.result.isError); assert.equal(approvals, 0);
  const response = await rpc('tools/call', { name: 'run_detached', arguments: {
    action: 'close', id: run.id, evidence: 'Checked the full process table; no remaining descendants or groups.' } });
  assert.ok(!response.result.isError);
  const closed = JSON.parse(response.result.content[0].text);
  assert.equal(closed.status, 'lost'); assert.ok(closed.closed.at); assert.equal(approvals, 1);
});
