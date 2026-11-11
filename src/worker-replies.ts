import { mentionText, type ConversationLinks } from './conversation-links.js';
import { replyContent, replyRelation } from './message-format.js';
import type { WorkerFile, WorkerTask } from './worker-queue.js';

// Prepared ciphertext is persisted by WorkerQueue before delivery. Keep grants
// on the last text part (not on an attachment, which cannot wake a peer).
export async function prepareWorkerReply(task: WorkerTask, bot: string, links: ConversationLinks | undefined, transport: {
  authorize(): Promise<void>;
  file(file: WorkerFile): Promise<Record<string, unknown>>;
  encrypt(content: Record<string, unknown>): Promise<unknown>;
}): Promise<unknown[]> {
  await transport.authorize();
  const mentions = links?.mentions(bot, task.room, task.response!.text);
  const text = mentions?.text ?? task.response!.text;
  const visible = mentions?.mentions.length ? mentionText(text, mentions.mentions, id => links!.displayName(id)) : text;
  const contents: Record<string, unknown>[] = (task.initiative || links?.room(bot, task.room)) && text.trim() === 'NO_REPLY'
    ? [] : visible ? replyContent(visible, true, false, 'm.text') : [];
  const lastText = contents.length - 1;
  for (const file of task.response!.files) contents.push(await transport.file(file));
  const relation = task.event.content?.['m.relates_to'];
  const thread = relation?.rel_type === 'm.thread' && typeof relation.event_id === 'string'
    ? { rel_type: 'm.thread', event_id: relation.event_id } : undefined;
  const encrypted: unknown[] = [];
  for (const [index, content] of contents.entries()) {
    await transport.authorize();
    const outgoing = links ? links.outgoing(bot, task.room, content, index === lastText ? mentions?.mentions : undefined, task.id) : content;
    encrypted.push(await transport.encrypt({ ...outgoing, 'm.relates_to': replyRelation(thread, mentions?.replyTo) }));
  }
  return encrypted;
}
