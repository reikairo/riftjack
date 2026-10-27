import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmationInput, requestConfirmation } from '../src/confirmation-mcp.js';
import { Interactions } from '../src/interactions.js';

const proposal = { question: 'Implement the proposed feature?', details: 'Local changes and tests only.' };
for (const [reaction, status] of [['✅', 'approved'], ['❌', 'declined']]) {
  test(`confirmation records ${status} for the exact displayed proposal`, async () => {
    const interactions = new Interactions();
    let shown = '';
    const response = await requestConfirmation(proposal, new AbortController().signal, (request, signal) =>
      interactions.ask(request, signal, async (text, controls) => {
        shown = text; controls.bind('$prompt');
        interactions.react('$unrelated', '✅');
        assert.equal(interactions.size, 1);
        interactions.react('$prompt', reaction);
      }));
    const result = JSON.parse(response);
    assert.equal(result.status, status);
    assert.equal(result.question, proposal.question); assert.equal(result.details, proposal.details);
    assert.match(result.request_id, /^[a-f0-9-]{36}$/);
    assert.ok(shown.includes(proposal.question) && shown.includes(proposal.details));
    assert.equal(interactions.size, 0);
    assert.equal(interactions.react('$prompt', '✅'), undefined);
  });
}

test('expiry is distinct from refusal and invalidates late reactions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const interactions = new Interactions();
  const pending = requestConfirmation({ ...proposal, timeout_seconds: 1 }, new AbortController().signal,
    (request, signal) => interactions.ask(request, signal, async (_text, controls) => { controls.bind('$expired'); }));
  t.mock.timers.tick(1000);
  assert.equal(JSON.parse(await pending).status, 'expired');
  assert.equal(interactions.size, 0);
  assert.equal(interactions.react('$expired', '✅'), undefined);
});

test('cancellation and delivery failure never become refusal or approval', async () => {
  const interactions = new Interactions(), lifetime = new AbortController();
  const pending = requestConfirmation(proposal, lifetime.signal,
    (request, signal) => interactions.ask(request, signal, async (_text, controls) => { controls.bind('$cancelled'); }));
  const error = new Error('Turn stopped'); lifetime.abort(error);
  await assert.rejects(pending, e => e === error);
  assert.equal(interactions.size, 0);
  assert.equal(interactions.react('$cancelled', '✅'), undefined);
  await assert.rejects(requestConfirmation(proposal, new AbortController().signal, async () => { throw new Error('Delivery failed'); }), /Delivery failed/);
  await assert.rejects(requestConfirmation(proposal, new AbortController().signal, async () => ({})), /No consent/);
});

test('a timely human approval survives slow reaction seeding past the deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const interactions = new Interactions();
  let finishDelivery!: () => void;
  const delivery = new Promise<void>(resolve => { finishDelivery = resolve; });
  const pending = requestConfirmation({ ...proposal, timeout_seconds: 1 }, new AbortController().signal,
    (request, signal) => interactions.ask(request, signal, async (_text, controls) => {
      controls.bind('$timely'); interactions.react('$timely', '✅');
      await delivery;
    }));
  t.mock.timers.tick(1000);
  finishDelivery();
  assert.equal(JSON.parse(await pending).status, 'approved');
});

test('closing a turn invalidates its confirmations, without accepting them in a new turn', async () => {
  const old = new Interactions();
  const pending = requestConfirmation(proposal, new AbortController().signal,
    (request, signal) => old.ask(request, signal, async (_text, controls) => { controls.bind('$old'); }));
  old.close(); await assert.rejects(pending);
  const current = new Interactions();
  const result = await requestConfirmation(proposal, new AbortController().signal,
    (request, signal) => current.ask(request, signal, async (_text, controls) => {
      controls.bind('$new'); assert.equal(current.react('$old', '✅'), undefined);
      assert.equal(current.size, 1); current.react('$new', '❌');
    }));
  assert.equal(JSON.parse(result).status, 'declined');
});

test('confirmation validates full text and rejects executable or routing parameters', async () => {
  for (const input of [null, [], {}, { question: ' ' }, { question: 'a'.repeat(4001) },
    { ...proposal, details: 'a'.repeat(12001) }, { ...proposal, command: 'execute' }, { ...proposal, room: '!other:test' },
    ...[0, 3601, 1.5, '1'].map(timeout_seconds => ({ ...proposal, timeout_seconds }))]) {
    assert.throws(() => confirmationInput(input));
  }
  const text = 'Открыть **проект**? ```\n✅';
  await requestConfirmation({ question: text }, new AbortController().signal, async request => {
    assert.ok(request.text.includes(text)); assert.notEqual(request.markdown, request.text);
    return request.deny;
  });
});
