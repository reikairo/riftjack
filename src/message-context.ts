import { AGENT_TRIGGER, NOTICE, type MatrixEvent } from './bridge.js';

// Call only with an admitted event; Matrix IDs are identifiers, not display names.
export function matrixPrompt(bot: string, room: string, event: MatrixEvent, prompt: string,
  linked: Record<string, unknown> = {}): string {
  const trigger = event.content?.[AGENT_TRIGGER], notice = event.content?.[NOTICE];
  const relation = event.content?.['m.relates_to'];
  const context = { bot, room, visibility: 'private', human: event.sender,
    author: trigger?.agent ?? (notice && notice !== 'reaction' ? 'connector' : event.sender),
    trigger: trigger ? 'agent-mention' : notice ?? 'human-message',
    ...(relation?.rel_type === 'm.thread' && { thread: relation.event_id }), ...linked };
  return 'Matrix message context:\n' + JSON.stringify(context)
    + (trigger || notice ? '\nCurrent connector notice:\n' : '\nCurrent human message:\n')
    + (linked.alreadyDelivered ? 'This mention was already shown to you as an unread observation in an earlier turn. '
      + 'If you have already answered it, a second answer is not needed: reply with exactly NO_REPLY.\n' : '') + prompt;
}
