import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startNotesMcp } from '../../src/room-notes-mcp.js';
import { RoomNotes, notesAction } from '../../src/room-notes.js';
import { loadConfig } from '../../src/config.js';
import { State } from '../../src/state.js';
import { createBackend } from '../../src/backends.js';
import type { ToolConnection } from '../../src/tool-mcp.js';

async function call(connection: ToolConnection, id: number, args: unknown) {
  return fetch(connection.url, { method: 'POST', headers: { ...connection.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'room_notes', arguments: args } }) });
}

test('notes MCP authenticates, scopes edits and rejects stale versions and replay', async t => {
  const root = mkdtempSync(join(tmpdir(), 'notes-mcp-')), notes = new RoomNotes(join(root, 'notes.json'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = await startNotesMcp(async input => notesAction(notes, '!room:test', '@bot:test', input), new AbortController().signal);
  t.after(() => server.close());
  assert.equal((await call({ ...server, headers: { Authorization: 'wrong' } }, 1, { action: 'read' })).status, 401);
  const edit = { action: 'set', expectedVersion: 0, text: 'reference' };
  assert.equal((await (await call(server, 2, edit)).json()).result.isError, undefined);
  assert.ok((await (await call(server, 2, edit)).json()).error);
  assert.equal((await (await call(server, 3, edit)).json()).result.isError, true);
  assert.equal((await (await call(server, 4, { action: 'read', room: '!other:test' })).json()).result.isError, true);
  assert.equal(notes.read('!room:test').version, 1);
  assert.equal(notes.read('!other:test').version, 0);
  await server.close();
  await assert.rejects(call(server, 5, { action: 'read' }));
});

for (const kind of ['codex', 'claude'] as const) test(`${kind} exposes notes on new and resumed turns and closes each task endpoint`, { timeout: 20_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'notes-backend-'))), cli = join(root, 'cli.cjs');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(cli, `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2),send=v=>console.log(JSON.stringify(v));
if(args.includes('--help')){console.log('--input-format --output-format --permission-mode --permission-prompt-tool --append-system-prompt --tools --settings --resume');process.exit();}
if(args[0]==='auth'){send({loggedIn:true,authMethod:'claude.ai'});process.exit();}
let connection,instructions;
async function work(){
 fs.appendFileSync(__filename+'.connections',JSON.stringify(connection)+'\\n');
 if(!instructions.includes('room_notes'))throw Error('Missing notes instructions');
 const r=await fetch(connection.url,{method:'POST',headers:{...connection.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'room_notes',arguments:{action:'read'}}})});
 const result=(await r.json()).result;
 if(result.isError||JSON.parse(result.content[0].text).text!=='reference')throw Error('Missing notes');
 return 'Read notes.';
}
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{try{
 const m=JSON.parse(line),p=m.params,reply=result=>send({id:m.id,result});
 if(args.includes('--print')){
  connection=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.riftjack_notes;
  if(!args[args.indexOf('--allowedTools')+1].split(',').includes('mcp__riftjack_notes__room_notes'))throw Error('Missing allowed tool');
  instructions=args[args.indexOf('--append-system-prompt')+1];
  send({type:'system',subtype:'init',session_id:'same-session'});
  send({type:'result',subtype:'success',result:await work(),session_id:'same-session'});return;
 }
 if(m.method==='initialize')reply({});
 if(m.method==='account/read')reply({account:{type:'chatgpt'}});
 if(m.method==='thread/start'||m.method==='thread/resume'){
  const c=p.config['mcp_servers.riftjack_notes'];
  if(!c.required||c.enabled_tools.join()!=='room_notes')throw Error('Missing tool policy');
  connection={url:c.url,headers:c.http_headers};
  if(p.developerInstructions!==undefined){instructions=p.developerInstructions;fs.writeFileSync(__filename+'.instructions',instructions);}
  else instructions=fs.readFileSync(__filename+'.instructions','utf8');
  reply({thread:{id:'same-session'}});
 }
 if(m.method==='thread/inject_items')reply({});
 if(m.method==='turn/start'){
  reply({turn:{id:'turn',status:'inProgress'}});
  send({method:'turn/started',params:{threadId:'same-session',turn:{id:'turn',status:'inProgress'}}});
  const text=await work();
  send({method:'turn/completed',params:{threadId:'same-session',turn:{id:'turn',status:'completed',items:[{id:'final',type:'agentMessage',phase:'final_answer',text}]}}});
 }
}catch(e){console.error(e);process.exit(2);}});
`, { mode: 0o700 });
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@alice:test', RIFTJACK_WORKSPACE: root, CODEX_PATH: cli, CLAUDE_PATH: cli });
  const state = new State(join(root, 'state.json')), backend = createBackend(config, state);
  for (let n = 0; n < 2; n++) {
    const result = await backend(kind, 'Read room notes.', 'session', AbortSignal.timeout(12_000), '@alice:test', [], undefined, undefined,
      { roomNotes: async () => JSON.stringify({ version: 1, text: 'reference' }) });
    assert.equal(typeof result === 'string' ? result : result.text, 'Read notes.');
  }
  const connections = readFileSync(cli + '.connections', 'utf8').trim().split('\n').map(s => JSON.parse(s));
  assert.equal(connections.length, 2);
  assert.notEqual(connections[0].headers.Authorization, connections[1].headers.Authorization);
  for (const connection of connections) await assert.rejects(call(connection, 10, { action: 'read' }));
});
