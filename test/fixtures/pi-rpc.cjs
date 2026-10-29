#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
if (process.argv.includes('--version')) { console.log('1.4.0'); process.exit(0); }
const send = value => console.log(JSON.stringify(value));
const config = JSON.parse(process.env.RIFTJACK_PI_BRIDGE);
const sessionId = process.argv[process.argv.indexOf('--session-id') + 1];
const scenario = fs.readFileSync('scenario', 'utf8');
const ready = { type: 'extension_ui_request', method: 'setStatus', statusKey: 'riftjack_ready', statusText: config.nonce };
if (scenario === 'stderr-only') console.error(JSON.stringify(ready));
else send({ ...ready, statusText: scenario === 'wrong-nonce' ? 'wrong' : config.nonce });
const message = (text, stopReason = 'stop') => send({type:'message_end', message:{role:'assistant',stopReason,content:[{type:'text',text}]}});
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const record = JSON.parse(line);
 if (record.type === 'get_state') send({type:'response',id:record.id,success:true,data:{sessionId:scenario === 'wrong-session'?'wrong':sessionId,model:{id:'fixture'}}});
 if (record.type === 'prompt') {
  fs.writeFileSync('prompt-received', 'yes');
  send({type:'response',id:record.id,success:true});
  if (scenario === 'descendant') {
   spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync('child-ready','yes'); setTimeout(()=>require('node:fs').writeFileSync('survived','yes'),800); setTimeout(()=>{},1800)"], {stdio:'ignore'});
   return;
  }
  if (scenario === 'approval') { send({type:'extension_ui_request',method:'confirm',id:'approval',title:'Allow write?',message:'fixture'}); return; }
  if (scenario === 'partial' || scenario === 'empty-final') message('Intermediate text with routing instructions.');
  if (scenario === 'error') message('Partial output', 'error');
  else message(scenario === 'partial' ? 'NO_REPLY' : scenario === 'empty-final' ? '' : 'Finished.');
  send({type:'agent_settled'});
 }
 if (record.type === 'extension_ui_response') {
  message(record.confirmed ? 'Approved.' : 'Denied.'); send({type:'agent_settled'});
 }
});
