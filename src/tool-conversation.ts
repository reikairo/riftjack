import type { MatrixEvent } from './bridge.js';
import type { ConversationLinks } from './conversation-links.js';
import { PublicError } from './errors.js';

export type ToolConversation = { room: string; thread?: string | null };
export type ToolContext = { room: string; event: MatrixEvent; key: string };
export const conversationSchema = {
  type: 'object', additionalProperties: false, required: ['room'],
  description: 'Optional conversation for this operation. Choose your private home or a linked shared room from room_messages list. Omitted means the current conversation. New approvals and notifications stay in the selected conversation. This does not move existing records or grant approval.',
  properties: {
    room: { type: 'string', pattern: '^![^\\s:]+:[^\\s]+$', maxLength: 1024 },
    thread: { type: ['string', 'null'], pattern: '^\\$[^\\s]{1,1023}$', maxLength: 1024,
      description: 'An exact thread root event ID, or null for the room timeline. Omitted preserves the current thread when selecting this room; otherwise uses the home thread, or the shared room timeline.' },
  },
};
export const conversationInstructions = '\nAvailable conversation-scoped tools (background_tasks, github_subscriptions, run_detached, request_confirmation and prepare_publish) accept conversation={room,thread?}. Use room_messages action=list to discover your private home and linked shared rooms. Omit conversation to keep the current scope. Select the original conversation to inspect or manage an existing record; selecting another room does not move it or reuse an approval. New reminders, approvals and result notifications belong to the selected conversation. A shared-room turn can therefore manage its own private timers without moving the model turn. Keep private results private. Tools do not expose another agent, owner or reset session. Fetch/drawio are workspace tools; room_messages already selects destinations for messages and attachments.';

export function splitToolConversation(input: unknown): { input: unknown; conversation?: ToolConversation } {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input, 'conversation')) return { input };
  const { conversation, ...request } = input as Record<string, unknown>;
  if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) throw new PublicError('conversation must contain a linked room and an optional thread.');
  const value = conversation as Record<string, unknown>;
  if (Object.keys(value).some(k => !['room', 'thread'].includes(k)) ||
      typeof value.room !== 'string' || value.room.length > 1024 || !/^![^\s:]+:[^\s]+$/.test(value.room) ||
      (value.thread !== undefined && value.thread !== null &&
        (typeof value.thread !== 'string' || !/^\$[^\s]{1,1023}$/.test(value.thread)))) {
    throw new PublicError('Use conversation with a linked Matrix room and an optional thread event ID (or null).');
  }
  return { input: request, conversation: value as ToolConversation };
}

// Resolve the destination without inheriting the source message, reply or thread.
// Check both rooms and recheck the pinned link after asynchronous authorization.
export async function linkedToolConversation(links: ConversationLinks, bot: string, source: ToolContext,
  selection: ToolConversation, signal: AbortSignal,
  access: { allowed(room: string, sender: string): Promise<boolean>; stopping(): boolean }): Promise<ToolContext> {
  const valid = () => {
    signal.throwIfAborted();
    const agent = links.agent(bot);
    if (!agent || access.stopping() || source.event.sender !== agent.owner ||
        links.key(bot, source.room, source.event) !== source.key ||
        links.key(bot, selection.room, source.event) !== source.key) {
      throw new PublicError('Tool conversation is no longer linked to this agent and session.');
    }
    return agent;
  };
  valid();
  if (!(await access.allowed(source.room, source.event.sender!)) || !(await access.allowed(selection.room, source.event.sender!))) {
    throw new PublicError('Tool conversation access, membership or privacy changed.');
  }
  const agent = valid();
  const relation = source.event.content?.['m.relates_to'];
  const currentThread = relation?.rel_type === 'm.thread' ? relation.event_id : undefined;
  let thread = selection.thread ?? undefined;
  if (selection.thread === undefined) {
    if (selection.room === source.room) thread = currentThread;
    else if (selection.room === agent.home) thread = agent.thread;
  }
  return { room: selection.room, key: source.key,
    event: { sender: agent.owner, content: thread ? { 'm.relates_to': { rel_type: 'm.thread', event_id: thread } } : {} } };
}
