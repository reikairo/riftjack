import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { claudeModelOptions, piModelOptions } from '../src/cli-models.js';

function fixture(t: test.TestContext, scenario = 'normal') {
  const dir = mkdtempSync(join(tmpdir(), 'riftjack-catalog-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const cli = join(dir, 'cli.cjs');
  writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2), scenario = ${JSON.stringify(scenario)};
const log = x => fs.appendFileSync(__filename+'.log', JSON.stringify(x)+'\\n');
log({args, cwd:process.cwd(), secrets:['ANTHROPIC_API_KEY','OPENAI_API_KEY','MATRIX_OWNER_ID','SYNAPSE_ADMIN_TOKEN'].filter(k=>process.env[k])});
if(args.includes('--version')) { console.log('1.4.0'); process.exit(0); }
if(args.includes('--help')) { console.log('--input-format --output-format --permission-mode --permission-prompt-tool --append-system-prompt --tools --settings --resume'); process.exit(0); }
if(args[0]==='auth') {console.log(JSON.stringify({loggedIn:scenario!=='auth', authMethod:'claude.ai'})); process.exit(0);}
const lock=path.join(__dirname,'active'); fs.writeFileSync(lock,'active');
process.on('exit',()=>fs.unlinkSync(lock));
process.on('SIGTERM',()=>process.exit(0));
const send=x=>console.log(JSON.stringify(x));
const model={value:'test-alias',resolvedModel:'test-model',supportsEffort:true,supportedEffortLevels:['low','high'],supportsFastMode:true};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);log(q);
 if(scenario==='wait')return;
 if(scenario==='bad-json') {console.log('bad');return;}
 if(scenario==='interactive') {send({type:'control_request',request_id:'permission',request:{subtype:'can_use_tool'}});return;}
 if(q.type==='control_request') {
  const models=scenario==='empty'?[]:scenario==='invalid'?[null]:scenario==='old'?[{value:'old-model'}]:[model];
  send({type:'control_response',response:{request_id:'unrelated',subtype:'success',response:{models:[]}}});
  send({type:'control_response',response:{request_id:q.request_id,subtype:scenario==='error'?'error':'success',response:{models}}});
 } else {
  const data=q.type==='get_state'?{model:{provider:'test',id:'alpha'},thinkingLevel:'medium'}
   :q.type==='get_available_thinking_levels'?{levels:['off','low','medium','high']}
   :{models:scenario==='empty'?[]:scenario==='invalid'?[null]:[{provider:'test',id:'alpha',reasoning:true},{provider:'other',id:'beta',reasoning:false}]};
  send({type:'response',id:q.id,command:q.type,success:scenario!=='error',data});
 }
});
process.stdin.on('end',()=>process.exit(0));
`, {mode:0o700});
  const config = loadConfig({MATRIX_HOMESERVER:'https://example.org', MATRIX_OWNER_ID:'@owner:example.org',
    RIFTJACK_WORKSPACE:dir, CLAUDE_PATH:cli, PI_PATH:cli, PI_MODEL:'test/alpha', PI_REASONING_EFFORT:'medium'});
  return {config, active:()=>existsSync(join(dir,'active')),
    calls:()=>readFileSync(cli+'.log','utf8').trim().split('\n').map(x=>JSON.parse(x))};
}

test('Claude catalog uses initialization metadata and model-specific effort/fast-mode capabilities only', async t=>{
 const f=fixture(t);
 const text=await claudeModelOptions(f.config,AbortSignal.timeout(5000));
 assert.match(text,/test-alias.*test-model.*low.*high.*fast/);
 const calls=f.calls();
 assert.deepEqual(calls.filter(x=>x.type).map(x=>x.type),['control_request']);
 assert.equal(calls.find(x=>x.request)?.request.subtype,'initialize');
 const args=calls.filter(x=>x.args).at(-1).args;
 assert.equal(args[args.indexOf('--permission-mode')+1],'dontAsk');
 assert.equal(args[args.indexOf('--tools')+1],'');
 assert.ok(args.includes('--no-session-persistence'));
 assert.ok(args.includes('--strict-mcp-config'));
 assert.equal(JSON.parse(args[args.indexOf('--settings')+1]).disableAllHooks,true);
 assert.equal(calls.some(x=>x.args?.includes('--resume')),false);
 assert.equal(f.active(),false);
});

test('Pi catalog reads models and selected-model thinking levels without changing models or sending a prompt', async t=>{
 const f=fixture(t);
 const text=await piModelOptions(f.config,AbortSignal.timeout(5000));
 assert.match(text,/test\/alpha.*selected.*off.*low.*medium.*high/);
 assert.match(text,/other\/beta.*off only/);
 const calls=f.calls();
 assert.deepEqual(calls.filter(x=>x.type).map(x=>x.type),['get_available_models','get_state','get_available_thinking_levels']);
 const args=calls.filter(x=>x.args).at(-1).args;
 assert.ok(args.includes('--no-session'));
 assert.ok(args.includes('--no-extensions'));
 assert.equal(args[args.indexOf('--model')+1],'test/alpha');
 assert.equal(args[args.indexOf('--thinking')+1],'medium');
 assert.equal(f.active(),false);
});

for(const [kind,read] of [['Claude',claudeModelOptions],['Pi',piModelOptions]] as const) {
 test(`${kind} discovery handles empty catalogs, malformed data, RPC errors and unexpected permission requests`,async t=>{
  const empty=fixture(t,'empty');
  assert.match(await read(empty.config,AbortSignal.timeout(5000)),/no (selectable|configured) models/);
  for(const scenario of ['invalid','bad-json','error','interactive']) {
   const f=fixture(t,scenario);
   await assert.rejects(read(f.config,AbortSignal.timeout(5000)));
   assert.equal(f.active(),false);
   assert.equal(f.calls().some(x=>['user','prompt','control_response','extension_ui_response','set_model'].includes(x.type)),false);
  }
 });
 test(`${kind} discovery cancels and reaps a stalled CLI`,async t=>{
  const f=fixture(t,'wait');
  await assert.rejects(read(f.config,AbortSignal.timeout(500)));
  assert.equal(f.active(),false);
 });
}

test('Claude missing effort metadata remains unknown and login failure never opens a catalog session',async t=>{
 const old=fixture(t,'old');
 assert.match(await claudeModelOptions(old.config,AbortSignal.timeout(5000)),/reasoning: not reported/);
 const auth=fixture(t,'auth');
 await assert.rejects(claudeModelOptions(auth.config,AbortSignal.timeout(5000)),/Sign in/);
 assert.equal(auth.calls().some(x=>x.type),false);
});
