import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadReply, threadRelation } from '../src/thread-reply.js';
import { AGENT_TRIGGER, NOTICE, type MatrixEvent } from '../src/bridge.js';

const event: MatrixEvent = { event_id: '$human', sender: '@alice:test', type: 'm.room.message',
  content: { body: 'A task', msgtype: 'm.text' } };
const block = '```matrix-thread\n{"create":true}\n```';

test('a thread directive targets only the triggering message and preserves the input event', () => {
  const result = threadReply('Answer\n\n' + block, event, true);
  assert.equal(result.text, 'Answer');
  assert.deepEqual(threadRelation(result.event), { rel_type: 'm.thread', event_id: '$human',
    is_falling_back: true, 'm.in_reply_to': { event_id: '$human' } });
  assert.equal(threadRelation(event), undefined);
});

test('existing thread roots and ordinary routing are preserved', () => {
  const threaded = { ...event, content: { ...event.content, 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } } };
  assert.equal(threadRelation(threadReply(block, threaded, true).event)?.event_id, '$root');
  assert.deepEqual(threadReply('Answer', threaded, true), { text: 'Answer', event: threaded });
  assert.deepEqual(threadRelation(threaded), { rel_type: 'm.thread', event_id: '$root' });
});

test('examples in outer fences, quotes and lists do not select a thread', () => {
  for (const text of ['````text\n' + block + '\n````', '> ' + block.replaceAll('\n', '\n> '),
    '- Example\n\n  ' + block.replaceAll('\n', '\n  ')]) {
    assert.deepEqual(threadReply(text, event, true), { text, event });
  }
  const example = '````text\n' + block + '\n````';
  assert.equal(threadReply(example + '\n\n' + block, event, true).text, example);
});

test('invalid directives and unsupported contexts fail closed', () => {
  for (const json of ['not-json', 'null', '[]', '{"create":false}', '{"create":true,"room":"!other:test"}',
    '{"create":true,"event_id":"$other"}']) {
    assert.throws(() => threadReply('```matrix-thread\n' + json + '\n```', event, true));
  }
  assert.throws(() => threadReply(block + '\n\n' + block, event, true));
  assert.throws(() => threadReply(block, event, false));
  for (const content of [{ ...event.content, [NOTICE]: 'timer' as const },
    { ...event.content, [AGENT_TRIGGER]: { agent: '@peer:test', event: '$peer' } }]) {
    assert.throws(() => threadReply(block, { ...event, content }, true));
  }
  assert.throws(() => threadReply(block, { ...event, event_id: undefined }, true));
  assert.throws(() => threadReply(block, { ...event, content: { ...event.content,
    'm.relates_to': { rel_type: 'm.thread', event_id: 'invalid' } } }, true));
});
