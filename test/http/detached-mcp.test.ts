import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
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
