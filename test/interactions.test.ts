import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interactions } from '../src/interactions.js';
import { codexInteraction, deniedRequest } from '../src/codex-interactions.js';
import { loadConfig } from '../src/config.js';

const request = { text: 'Run echo?', approve: { decision: 'accept' }, deny: { decision: 'decline' } };
const signal = () => new AbortController().signal;
const ask = (method: string, params: Record<string, any>, item?: Record<string, any>) => codexInteraction({ id: 1, method, params }, item)!;

test('reactions select exact requests, reject unsupported emoji and cannot replay or approve forms', async () => {
  const pending = new Interactions();
  const a = pending.ask(request, signal(), async (_text, controls) => {
    assert.deepEqual(controls.keys, ['✅', '❌']); controls.bind('$a');
  });
  const b = pending.ask({ text: 'Fill form', deny: { cancelled: true }, answer: text => ({ text }) }, signal(), async (_text, controls) => {
    assert.deepEqual(controls.keys, ['❌']); controls.bind('$b');
  });
  assert.equal(pending.react('$a', '👍'), undefined);
  assert.equal(pending.react('$a', '🔖'), undefined);
  assert.equal(pending.react('$b', '🔖'), undefined);
  assert.equal(pending.react('$unknown', '✅'), undefined);
  assert.match(pending.react('$b', '✅')!, /needs !answer/);
  assert.equal(pending.size, 2);
  assert.match(pending.react('$a', '✅\uFE0F')!, /Answer sent/);
  assert.deepEqual(await a, request.approve);
  assert.equal(pending.react('$a', '❌'), undefined);
  assert.equal(pending.size, 1);
  pending.react('$b', '❌'); assert.deepEqual(await b, { cancelled: true });
});

test('aborted and closed reaction bindings cannot affect later requests', async () => {
  for (const close of [false, true]) {
    const pending = new Interactions(), controller = new AbortController();
    const a = pending.ask(request, controller.signal, async (_text, controls) => controls.bind('$old'));
    await Promise.resolve(); // Let the complete mock delivery finish before answering.
    const rejected = assert.rejects(a);
    if (close) pending.close(); else controller.abort();
    await rejected;
    const b = pending.ask(request, signal(), async (_text, controls) => controls.bind('$new'));
    await Promise.resolve(); // Let the complete mock delivery finish before answering.
    assert.equal(pending.react('$old', '✅'), undefined);
    assert.equal(pending.size, 1);
    pending.react('$new', '❌'); await b;
  }
});

test('delivery failure never leaves an actionable confirmation', async () => {
  const pending = new Interactions();
  let message = '';
  await assert.rejects(pending.ask(request, signal(), async text => { message = text; throw new Error('Delivery failed'); }), /Delivery failed/);
  assert.equal(pending.size, 0);
  const id = /^Confirmation (\w+)/.exec(message)![1];
  assert.match(pending.answer(`!approve ${id}`), /unknown, expired/);
});

test('aborted, timed-out and closed requests reject instead of accepting defaults', async () => {
  for (const reason of ['abort', 'timeout', 'close']) {
    const pending = new Interactions();
    const controller = new AbortController();
    const taskSignal = reason === 'timeout' ? AbortSignal.timeout(10) : controller.signal;
    const task = pending.ask(request, taskSignal, async () => {});
    await Promise.resolve(); // Let the complete mock delivery finish before answering.
    const rejected = assert.rejects(task);
    if (reason === 'close') pending.close();
    else if (reason === 'abort') controller.abort();
    else await new Promise(resolve => setTimeout(resolve, 15));
    await rejected;
    assert.equal(pending.size, 0);
  }
});

test('confirmation capacity and description limits reject before sending partial details', async () => {
  const pending = new Interactions();
  let sent = 0;
  const tasks = Array.from({ length: 10 }, () => pending.ask(request, signal(), async () => { sent++; }));
  const rejections = tasks.map(task => assert.rejects(task));
  await assert.rejects(pending.ask(request, signal(), async () => { sent++; }), /Too many/);
  assert.equal(sent, 10);
  pending.close(); await Promise.all(rejections);
  await assert.rejects(pending.ask({ ...request, text: 'x'.repeat(40_001) }, signal(), async () => { sent++; }), /too large/);
  assert.equal(sent, 10);
});

test('answer commands are single-use and reject extra text, malformed IDs and oversized input', async () => {
  const pending = new Interactions();
  let message = '';
  const task = pending.ask(request, signal(), async text => { message = text; });
  await Promise.resolve(); // Let the complete mock delivery finish before answering.
  const id = /^Confirmation (\w+)/.exec(message)![1];
  assert.match(pending.answer(`!approve ${id} extra`), /without extra text/);
  assert.match(pending.answer('!approve malformed'), /Use !approve/);
  assert.match(pending.answer('!answer ' + 'x'.repeat(16_000)), /at most/);
  assert.equal(pending.size, 1);
  pending.answer(`!deny ${id}`);
  assert.deepEqual(await task, { decision: 'decline' });
  assert.match(pending.answer(`!approve ${id}`), /already answered/);
});

for (const verb of ['approve', 'deny']) test(`${verb} without an ID resolves only the single pending request`, async () => {
  const pending = new Interactions();
  const task = pending.ask(request, signal(), async () => {});
  await Promise.resolve(); // Let the complete mock delivery finish before answering.
  assert.match(pending.answer(`!${verb}`), verb === 'approve' ? /Answer sent/ : /Declined/);
  assert.deepEqual(await task, verb === 'approve' ? request.approve : request.deny);
  assert.equal(pending.size, 0);
  assert.match(pending.answer(`!${verb}`), /No pending/);
});

test('ID-less answers preserve plain text and JSON, while bare approvals cannot answer forms', async () => {
  for (const answer of ['blue sky', '{"confirm":true}']) {
    const pending = new Interactions();
    const task = pending.ask({ text: 'Answer?', deny: {}, answer: text => ({ text }) }, signal(), async () => {});
    await Promise.resolve(); // Let the complete mock delivery finish before answering.
    assert.match(pending.answer('!approve'), /needs !answer/);
    assert.match(pending.answer('!answer'), /does not accept/);
    pending.answer(`!answer ${answer}`);
    assert.deepEqual(await task, { text: answer });
  }
});

test('ID-less commands require exactly one unresolved request, including after denial or withdrawal', async () => {
  const pending = new Interactions();
  const a = pending.ask(request, signal(), async () => {});
  await Promise.resolve(); // Let the complete mock delivery finish before answering.
  const abort = new AbortController();
  const b = pending.ask(request, abort.signal, async () => {});
  await Promise.resolve(); // Let the complete mock delivery finish before answering.
  const bRejected = assert.rejects(b);
  for (const command of ['!approve', '!deny', '!answer yes']) assert.match(pending.answer(command), /More than one/);
  assert.equal(pending.size, 2);
  abort.abort(); await bRejected;
  pending.answer('!deny'); await a;
  const c = pending.ask(request, signal(), async () => {});
  await Promise.resolve(); // Let the complete mock delivery finish before answering.
  pending.answer('!approve');
  assert.deepEqual(await c, request.approve);
});

test('explicit stale or unknown IDs never resolve a different single pending request', async () => {
  const pending = new Interactions();
  let oldMessage = '';
  const old = pending.ask(request, signal(), async text => { oldMessage = text; });
  await Promise.resolve(); // Let the complete mock delivery finish before answering.
  const id = /^Confirmation (\w+)/.exec(oldMessage)![1];
  pending.answer('!deny'); await old;
  const current = pending.ask(request, signal(), async () => {});
  await Promise.resolve(); // Let the complete mock delivery finish before answering.
  for (const command of [`!approve ${id}`, `!deny ${id}`, `!answer ${id} yes`, '!approve 000000000000']) {
    assert.match(pending.answer(command), /unknown, expired/);
    assert.equal(pending.size, 1);
  }
  pending.answer('!approve'); await current;
});

test('ordinary command and file approvals remain single-request grants', () => {
  const command = ask('item/commandExecution/requestApproval', { command: 'echo hello', cwd: '/workspace', availableDecisions: ['accept', 'acceptForSession'], proposedExecpolicyAmendment: ['echo'] });
  assert.match(command.text, /echo hello/);
  assert.deepEqual(command.approve, { decision: 'accept' });
  assert.equal(ask('item/commandExecution/requestApproval', {}).approve, undefined);
  assert.equal(ask('item/commandExecution/requestApproval', { command: 'echo', availableDecisions: ['decline'] }).approve, undefined);
  const diff = [{ path: '/workspace/a.txt', kind: { type: 'update', move_path: null }, diff: '-old\n+new' }];
  const file = ask('item/fileChange/requestApproval', { grantRoot: '/workspace' }, { changes: diff });
  assert.match(file.text, /old/); assert.match(file.text, /new/);
  assert.deepEqual(file.approve, { decision: 'accept' });
  assert.equal(ask('item/fileChange/requestApproval', {}).approve, undefined);
});

test('remembering a command requires the owner, a valid proposal and an available matching decision', () => {
  const prefix = ['npm', 'run', 'test:http'];
  const decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } };
  const params = { command: 'npm run test:http', cwd: '/workspace', proposedExecpolicyAmendment: prefix,
    reason: `Assessed permission scope.\nRiftjack-Persist: ${JSON.stringify(prefix)}` };
  const interaction = (overrides: Record<string, unknown> = {}, owner = true) => codexInteraction({
    id: 1, method: 'item/commandExecution/requestApproval', params: { ...params, ...overrides },
  }, undefined, owner)!;
  for (const availableDecisions of [undefined, null, ['accept', 'decline', decision]]) {
    const request = interaction({ availableDecisions });
    assert.deepEqual(request.answer!('remember'), { decision });
    assert.deepEqual(request.approve, { decision: 'accept' });
    assert.match(request.text, /not restricted to this working directory/);
    assert.match(request.text, /other sessions and bots/);
    assert.ok(request.text.includes(JSON.stringify(prefix, null, 2)));
    assert.doesNotMatch(request.text, /Riftjack-Persist/);
    assert.throws(() => request.answer!('remember npm'), /exactly the displayed prefix/);
    assert.throws(() => request.answer!('yes'), /listed answer/);
  }
  assert.equal(interaction({}, false).answer, undefined);
  for (const proposedExecpolicyAmendment of [undefined, null, [], 'npm', ['npm', 1], [''], ['npm\0']]) {
    assert.equal(interaction({ proposedExecpolicyAmendment }).answer, undefined);
  }
  for (const overrides of [
    { command: '' }, { kind: 'stdin' }, { networkApprovalContext: { host: 'example.com', protocol: 'https' } },
    { availableDecisions: [] }, { availableDecisions: ['accept', 'decline'] }, { availableDecisions: 'accept' },
    { availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm'] } }] },
  ]) assert.equal(interaction(overrides).answer, undefined);
});

test('automatic server proposals cannot replace explicit matching agent intent', () => {
  const prefix = ['npm', 'run', 'test:http'];
  const marker = 'Riftjack-Persist: ' + JSON.stringify(prefix);
  for (const reason of [undefined, 'One-time only: editable project tests.', marker,
    'Explanation\n' + marker + '\nMore text', 'Explanation\n' + marker + '\n' + marker,
    'Explanation\nRiftjack-Persist: not-json', 'Explanation\nRiftjack-Persist: []',
    'Explanation\nRiftjack-Persist: ["npm"]', 'Explanation\nRiftjack-Persist: [1]',
    'Explanation\nRiftjack-Persist: [""]', 'Explanation\nRiftjack-Persist: ["npm\\u0000"]']) {
    const request = codexInteraction({ id: 1, method: 'item/commandExecution/requestApproval', params: {
      command: 'npm run test:http', reason, proposedExecpolicyAmendment: prefix,
      availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } }],
    } }, undefined, true)!;
    for (const field of ['answer', 'answerLabel', 'answerHint', 'answerReaction'] as const) assert.equal(request[field], undefined);
    assert.match(request.text, /This request only/);
    assert.deepEqual(request.approve, { decision: 'accept' });
    assert.deepEqual(request.deny, { decision: 'decline' });
  }
  const request = codexInteraction({ id: 1, method: 'item/commandExecution/requestApproval', params: {
    command: 'echo "' + marker + '"', reason: 'One-time only', proposedExecpolicyAmendment: prefix,
  } }, undefined, true)!;
  assert.equal(request.answer, undefined);
});

test('remember is explicit, bound to a fully delivered confirmation, and never selected by approval reactions', async () => {
  const prefix = ['npm', 'run', 'test:http'];
  for (const choice of ['remember', 'bookmark', 'bookmark-variation', 'approve', 'reaction', 'deny']) {
    const pending = new Interactions();
    const request = codexInteraction({ id: 1, method: 'item/commandExecution/requestApproval',
      params: { command: 'npm run test:http', proposedExecpolicyAmendment: prefix,
        reason: `Assessed scope.\nRiftjack-Persist: ${JSON.stringify(prefix)}` } }, undefined, true)!;
    const result = pending.ask(request, signal(), async (text, controls, markdown) => {
      assert.match(pending.answer('!answer remember'), /still being delivered/);
      assert.match(text, /Approve and remember: !answer [a-f0-9]{12} remember/);
      assert.match(markdown, /Approve and remember: `\s*!answer [a-f0-9]{12} remember\s*`/);
      assert.deepEqual(controls.keys, ['✅', '❌', '🔖']);
      controls.bind('$confirmation');
    });
    await Promise.resolve();
    assert.match(pending.answer('!answer yes'), /listed answer/);
    assert.equal(pending.size, 1);
    if (choice === 'remember') pending.answer('!answer remember');
    else if (choice.startsWith('bookmark')) pending.react('$confirmation', choice === 'bookmark' ? '🔖' : '🔖\uFE0F');
    else if (choice === 'reaction') pending.react('$confirmation', '✅');
    else pending.answer('!' + choice);
    assert.deepEqual(await result, choice === 'remember' || choice.startsWith('bookmark')
      ? { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } } }
      : { decision: choice === 'deny' ? 'decline' : 'accept' });
    assert.match(pending.answer('!answer remember'), /No pending/);
    assert.equal(pending.react('$confirmation', '🔖'), undefined);
  }
});

test('permission grants are limited to the requested fields and current turn; decline grants nothing', () => {
  const permissions = ask('item/permissions/requestApproval', { cwd: '/workspace', permissions: { network: { enabled: true }, fileSystem: null } });
  assert.deepEqual(permissions.approve, { permissions: { network: { enabled: true } }, scope: 'turn' });
  assert.deepEqual(permissions.deny, { permissions: {}, scope: 'turn' });
});

test('bookmark reactions select their own prefix among parallel confirmations and expire on cancellation', async () => {
  const pending = new Interactions();
  const start = (prefix: string[], event: string, taskSignal = signal()) => pending.ask(codexInteraction({
    id: event, method: 'item/commandExecution/requestApproval',
    params: { command: prefix.join(' '), proposedExecpolicyAmendment: prefix,
      reason: `Assessed scope.\nRiftjack-Persist: ${JSON.stringify(prefix)}` },
  }, undefined, true)!, taskSignal, async (_text, controls) => controls.bind(event));
  const first = start(['npm', 'run', 'test:http'], '$first');
  const controller = new AbortController();
  const second = start(['git', 'fetch'], '$second', controller.signal);
  await Promise.resolve();
  assert.match(pending.answer('!answer remember'), /More than one/);
  pending.react('$first', '🔖');
  assert.deepEqual(await first, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'run', 'test:http'] } } });
  assert.equal(pending.size, 1);
  const rejected = assert.rejects(second);
  controller.abort(); await rejected;
  assert.equal(pending.react('$second', '🔖'), undefined);
});

test('questions require explicit answers and secret questions cannot collect credentials', () => {
  const questions = [{ id: 'a', question: 'First?' }, { id: 'b', question: 'Second?' }];
  const q = ask('item/tool/requestUserInput', { questions });
  assert.equal(q.approve, undefined);
  assert.throws(() => q.answer!('{"a":"yes"}'), /every question/);
  assert.throws(() => q.answer!('{"a":"yes","b":"no","extra":"x"}'), /Unknown question/);
  assert.deepEqual(JSON.parse(JSON.stringify(q.answer!('{"a":"yes","b":"no"}'))), { answers: { a: { answers: ['yes'] }, b: { answers: ['no'] } } });
  const secret = ask('item/tool/requestUserInput', { questions: [{ ...questions[0], isSecret: true }] });
  assert.equal(secret.answer, undefined); assert.equal(secret.approve, undefined);
});

test('MCP URLs require a browser acknowledgement; verification challenges cannot be approved', () => {
  const q = ask('mcpServer/elicitation/request', { mode: 'url', serverName: 'github', url: 'https://github.test/login' });
  assert.match(q.text, /does not certify successful authentication/);
  assert.deepEqual(q.approve, { action: 'accept', content: null, _meta: null });
  for (const url of ['javascript:alert(1)', 'https://user:password@example.test']) {
    assert.equal(ask('mcpServer/elicitation/request', { mode: 'url', url }), undefined);
  }
  for (const mode of ['openai/userVerification', 'openai/form', 'openaiForm']) {
    const unsupported = ask('mcpServer/elicitation/request', { mode });
    assert.equal(unsupported.approve, undefined); assert.equal(unsupported.answer, undefined);
  }
});

test('MCP forms validate required fields and primitive enums; defaults are not auto-submitted', () => {
  const q = ask('mcpServer/elicitation/request', { mode: 'form', serverName: 'test', requestedSchema: {
    type: 'object', required: ['count', 'choices'], properties: {
      count: { type: 'integer', minimum: 1, maximum: 4 },
      choices: { type: 'array', minItems: 1, items: { anyOf: [{ const: 'red', title: 'Red' }, { const: 'blue', title: 'Blue' }] } },
      optional: { type: 'boolean', default: true },
    },
  } });
  assert.equal(q.approve, undefined);
  assert.throws(() => q.answer!('{"count":2,"choices":["green"]}'), /does not match/);
  assert.throws(() => q.answer!('{"count":2.5,"choices":["red"]}'), /does not match/);
  assert.throws(() => q.answer!('{"count":2,"choices":["red"],"extra":true}'), /unknown fields/);
  assert.deepEqual(q.answer!('{"count":2,"choices":["red"]}'), { action: 'accept', content: { count: 2, choices: ['red'] }, _meta: null });
});

test('unknown RPCs have no approval path; escalation policy accepts only on-request and never', () => {
  assert.equal(deniedRequest('item/tool/call'), undefined);
  assert.equal(codexInteraction({ id: 1, method: 'unknown/approval', params: {} }), undefined);
  const env = { MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: process.cwd() };
  assert.equal(loadConfig(env).codexApprovalPolicy, 'on-request');
  assert.equal(loadConfig({ ...env, CODEX_APPROVAL_POLICY: 'never' }).codexApprovalPolicy, 'never');
  assert.throws(() => loadConfig({ ...env, CODEX_APPROVAL_POLICY: 'always' }), /CODEX_APPROVAL_POLICY/);
});

test('Codex reviewer defaults to the user and validates the explicit automatic-review choice', () => {
  const env = { MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: process.cwd() };
  assert.equal(loadConfig(env).codexApprovalsReviewer, 'user');
  assert.equal(loadConfig({ ...env, CODEX_APPROVALS_REVIEWER: ' auto_review ' }).codexApprovalsReviewer, 'auto_review');
  assert.equal(loadConfig({ ...env, CODEX_APPROVALS_REVIEWER: ' ' }).codexApprovalsReviewer, 'user');
  for (const value of ['never', 'always', 'guardian_subagent', 'auto']) {
    assert.throws(() => loadConfig({ ...env, CODEX_APPROVALS_REVIEWER: value }), /user or auto_review/);
  }
});
