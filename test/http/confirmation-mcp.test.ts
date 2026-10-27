import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startConfirmationMcp, requestConfirmation } from '../../src/confirmation-mcp.js';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../../src/backends.js';
import { loadConfig } from '../../src/config.js';
import { State } from '../../src/state.js';
import { Interactions } from '../../src/interactions.js';

test('confirmation MCP queues prompts and isolates reactions, cancellation and request IDs', async t => {
  const interactions = new Interactions();
  const shown: string[] = [];
  const server = await startConfirmationMcp((input, signal) => requestConfirmation(input, signal, (request, callSignal) => interactions.ask(request, callSignal, async (text, controls) => {
    shown.push(text); controls.bind('$prompt' + shown.length);
  })), new AbortController().signal);
  t.after(() => server.close());
  const rpc = async (method: string, params: object, id?: number, auth = server.headers.Authorization) => {
    const res = await fetch(server.url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined && { id }), method, params }) });
    return res.status === 200 ? res.json() : { status: res.status };
  };
  const params = (question: string) => ({ name: 'request_confirmation', arguments: { question } });
  assert.equal((await rpc('tools/call', params('Unauthorized'), 1, 'Bearer wrong')).status, 401);
  const first = rpc('tools/call', params('First proposal'), 2);
  await waitFor(() => shown.length === 1);
  const second = rpc('tools/call', params('Second proposal'), 3);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(shown.length, 1);
  interactions.react('$prompt1', '✅');
  assert.equal(JSON.parse((await first).result.content[0].text).status, 'approved');
  await waitFor(() => shown.length === 2);
  assert.equal(interactions.react('$prompt1', '✅'), undefined);
  interactions.react('$prompt2', '❌');
  assert.equal(JSON.parse((await second).result.content[0].text).status, 'declined');
  assert.ok((await rpc('tools/call', params('Replay'), 2)).error);
  const third = rpc('tools/call', params('Cancel proposal'), 4);
  await waitFor(() => shown.length === 3);
  await rpc('notifications/cancelled', { requestId: 4 });
  const cancelled = (await third).result;
  assert.ok(cancelled.isError); assert.match(cancelled.content[0].text, /not a human refusal or approval/);
  assert.equal(interactions.size, 0);
  assert.equal(interactions.react('$prompt3', '✅'), undefined);
});

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Expected prompt was not delivered');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}


for (const kind of ['codex', 'claude'] as const) test(`${kind} exposes confirmation MCP without a second approval and preserves human decision`, { timeout: 20_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'confirmation-backend-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, 'cli.cjs');
  writeFileSync(cli, `#!/usr/bin/env node
const args=process.argv.slice(2), send=v=>console.log(JSON.stringify(v));
if(args.includes('--help')) { console.log('--input-format --output-format --permission-mode --permission-prompt-tool --append-system-prompt --tools --settings --resume'); process.exit(); }
if(args[0]==='auth') { send({loggedIn:true,authMethod:'claude.ai'}); process.exit(); }
let connection;
async function work(){
 const r=await fetch(connection.url,{method:'POST',headers:{...connection.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'request_confirmation',arguments:{question:'Implement feature A?',details:'Local changes only.'}}})});
 const m=await r.json(); if(m.result.isError) throw Error(m.result.content[0].text);
 return JSON.parse(m.result.content[0].text).status;
}
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 try{
 const message=JSON.parse(line);
 if(args.includes('--mcp-config')){
  connection=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.riftjack_confirmation;
  if(!args[args.indexOf('--allowedTools')+1].includes('mcp__riftjack_confirmation__request_confirmation')) throw Error('Missing tool');
  send({type:'system',subtype:'init',session_id:'confirmation-session'});
  send({type:'result',subtype:'success',result:await work(),session_id:'confirmation-session'}); return;
 }
 const {id,method,params:p}=message, reply=result=>send({id,result});
 if(method==='initialize') reply({});
 if(method==='account/read') reply({account:{type:'chatgpt'}});
 if(method==='thread/start'||method==='thread/resume'){
  const c=p.config['mcp_servers.riftjack_confirmation'];
  if(c.tools.request_confirmation.approval_mode!=='approve') throw Error('Unexpected second approval');
  connection={url:c.url,headers:c.http_headers}; reply({thread:{id:'confirmation-session'}});
 }
 if(method==='turn/start'){
  reply({turn:{id:'turn-1',status:'inProgress'}});
  send({method:'turn/completed',params:{threadId:'confirmation-session',turn:{id:'turn-1',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text:await work()}]}}});
 }
 }catch(error){console.error(error);process.exit(2);}
});
`, { mode: 0o700 });
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@alice:test', RIFTJACK_WORKSPACE: root, CODEX_PATH: cli, CLAUDE_PATH: cli });
  const state = new State(join(root, 'sessions.json')), backend = createBackend(config, state);
  const interactions = new Interactions(); let count = 0;
  const interact = (request: import('../../src/interactions.js').Interaction, signal: AbortSignal) => interactions.ask(request, signal, async (text, controls) => {
      count++; assert.ok(text.includes('Implement feature A?')); controls.bind('$confirmation');
      interactions.react('$confirmation', '✅');
    });
  const result = await backend(kind, 'Ask before starting.', 'key', new AbortController().signal, '@alice:test', [],
    interact, undefined, { confirmation: (input, signal) => requestConfirmation(input, signal, interact) });
  assert.equal(result, 'approved'); assert.equal(count, 1); assert.equal(interactions.size, 0);
});
