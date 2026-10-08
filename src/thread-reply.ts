import { Marked, type Token, type Tokens } from 'marked';
import { AGENT_TRIGGER, NOTICE, type MatrixEvent } from './bridge.js';
import { PublicError } from './errors.js';

const isThreadBlock = (token: Token): token is Tokens.Code => token.type === 'code' && token.lang?.trim() === 'matrix-thread';

// Only an agent's final reply can select a thread. Never accept a target ID from it.
export function threadReply(text: string, event: MatrixEvent, shared: boolean): { text: string; event: MatrixEvent } {
  const tokens = new Marked().lexer(text), blocks = tokens.filter(isThreadBlock);
  if (!blocks.length) return { text, event };
  if (blocks.length !== 1) throw new PublicError('Use exactly one matrix-thread block.');
  let value: unknown;
  try { value = JSON.parse(blocks[0].text); }
  catch { throw new PublicError('Invalid matrix-thread JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 ||
      (value as { create?: unknown }).create !== true) throw new PublicError('Use matrix-thread with {"create":true}.');
  if (!shared || event.content?.[AGENT_TRIGGER] || event.content?.[NOTICE] || !event.event_id?.startsWith('$')) {
    throw new PublicError('A thread reply requires a human message in a shared room.');
  }
  const relation = event.content?.['m.relates_to'];
  const root = relation?.rel_type === 'm.thread' ? relation.event_id : event.event_id;
  if (!root?.startsWith('$')) throw new PublicError('Invalid thread root.');
  return {
    text: tokens.filter(token => !isThreadBlock(token)).map(token => token.raw).join('').trim(),
    event: { ...event, content: { ...event.content, 'm.relates_to': { rel_type: 'm.thread', event_id: root,
      is_falling_back: true, 'm.in_reply_to': { event_id: event.event_id } } } },
  };
}

export function threadRelation(event: MatrixEvent) {
  const relation = event.content?.['m.relates_to'];
  return relation?.rel_type === 'm.thread' ? { rel_type: 'm.thread', event_id: relation.event_id,
    ...(relation.is_falling_back !== undefined && { is_falling_back: relation.is_falling_back }),
    ...(relation['m.in_reply_to'] && { 'm.in_reply_to': relation['m.in_reply_to'] }) } : undefined;
}
