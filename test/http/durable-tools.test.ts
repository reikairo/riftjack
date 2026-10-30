import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfirmationJobs, createRunApprovalJobs } from '../../src/decision-jobs.js';
import type { ApprovalJobOptions } from '../../src/approval-jobs.js';
import { DetachedRuns } from '../../src/detached-runs.js';
import { DeliveryReceipts } from '../../src/delivery-receipts.js';
import { attachmentDelivery } from '../../src/attachment-delivery.js';
import { roomMessageDelivery } from '../../src/room-messages.js';
import { startAttachmentMcp } from '../../src/attachment-mcp.js';
import { startRoomMessageMcp } from '../../src/room-message-mcp.js';
import { startConfirmationMcp } from '../../src/confirmation-mcp.js';
import { startDetachedMcp } from '../../src/detached-mcp.js';
import type { ToolConnection } from '../../src/tool-mcp.js';
const target = { room: '!home:test', sender: '@alice:test', key: 'key', session: 'session' };
const signal = () => new AbortController().signal;
async function until(check: () => boolean) { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('Condition not reached'); }
let rpcId = 0;
async function call(server: ToolConnection, name: string, input: unknown) {
  const response = await fetch(server.url, { method: 'POST', headers: { ...server.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: input } }) });
  const result = await response.json(); assert.equal(result.result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.result.content[0].text);
}
for (const kind of ['confirmation', 'detached'] as const) test(`${kind} accepts approval after its submitting HTTP connection and turn close`, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'durable-http-')));
  let shown = false, notified = false;
  const options: Pick<ApprovalJobOptions, 'timeoutMs' | 'valid' | 'authorize' | 'send' | 'notify' | 'report'> = {
    timeoutMs: 10000, valid: () => true, authorize: async () => {},
    send: async (_target, _request, _text, controls) => { controls.bind('$review'); shown = true; },
    notify: () => { notified = true; }, report: () => {},
  };
  const jobs = kind === 'confirmation' ? createConfirmationJobs(join(root, 'jobs.json'), options)
    : createRunApprovalJobs(join(root, 'jobs.json'), options, new DetachedRuns(join(root, 'runs'), root, { notify: () => {}, processTable: () => [] }));
  const turn = new AbortController();
  const action = (input: unknown, signal: AbortSignal) => jobs.start(input, target, signal);
  const server = kind === 'confirmation' ? await startConfirmationMcp(action, turn.signal) : await startDetachedMcp(action, turn.signal);
  t.after(async () => { jobs.stop(); await server.close(); rmSync(root, { recursive: true, force: true }); });
  const receipt = await call(server, kind === 'confirmation' ? 'request_confirmation' : 'run_detached', kind === 'confirmation'
    ? { question: 'Proceed?' } : { action: 'start', label: 'Check', cwd: root, argv: [process.execPath, '-e', 'process.exit(0)'] });
  assert.equal(receipt.status, 'preparing');
  turn.abort(); await server.close(); await until(() => shown);
  await jobs.answer(target, '!approve'); await until(() => notified);
  const result = JSON.parse(jobs.status(target, receipt.request_id ?? receipt.operation_id));
  assert.equal(result.state, kind === 'confirmation' ? 'approved' : 'prepared');
});

for (const kind of ['attachments', 'rooms'] as const) test(`${kind} retrieves persisted receipts through a new MCP connection without resending`, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'durable-receipt-http-'))), path = join(root, 'receipts.json');
  writeFileSync(join(root, 'a.txt'), 'file'); let sent = 0;
  const make = async () => {
    const store = new DeliveryReceipts(path);
    if (kind === 'attachments') {
      const delivery = attachmentDelivery(root, 1024, async () => { sent++; }, () => store.scoped(target, 'attachments'));
      return startAttachmentMcp(delivery.action, signal());
    }
    return startRoomMessageMcp(roomMessageDelivery(async () => { sent++; return '{"status":"sent","event_id":"$sent"}'; }, () => store.scoped(target, 'rooms')), signal());
  };
  const name = kind === 'attachments' ? 'send_attachments' : 'room_messages';
  const input = kind === 'attachments' ? { id: 'delivery', files: [{ path: 'a.txt' }] } : { action: 'send', room: '!shared:test', text: 'Hello', id: 'delivery' };
  const first = await make(); t.after(() => first.close());
  await call(first, name, input); await first.close();
  const next = await make(); t.after(async () => { await next.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal((await call(next, name, { action: 'status', id: 'delivery' })).status, 'sent');
  await call(next, name, input); assert.equal(sent, 1);
});
