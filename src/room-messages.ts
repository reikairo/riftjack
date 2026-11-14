import type { ScopedReceipts } from './delivery-receipts.js';
import { createHash } from 'node:crypto';
import type { BackgroundTarget } from './background-tasks.js';
import { PublicError } from './errors.js';
import { mentionContent } from './message-format.js';
import { PEER_CREDIT, PEER_FIELD, type ConversationLinks } from './conversation-links.js';
import { GRANT, type MatrixEvent } from './bridge.js';
import { attachmentDelivery, attachmentFingerprint } from './attachment-delivery.js';
import { isMedia, outgoingAttachments, type IncomingAttachment, type OutgoingAttachment } from './media.js';

class DestinationUnavailable extends PublicError {}

// Use explicit recipients in groups; mention=true selects the sole peer in a pair room.
export type MessageRequest = { action: 'list' }
  | { action: 'continue_private'; text: string; id: string }
  | { action: 'send'; room: string; text: string; id: string; mention?: boolean; mentions?: string[] }
  | { action: 'receive_attachment'; room: string; event_id: string }
  | { action: 'send_files'; room: string; id: string; files: { path: string; name?: string }[]; outbox: string };
export type MessageAction = (request: MessageRequest, signal: AbortSignal) => Promise<string>;
export type RoomMessageTool = (input: unknown, signal: AbortSignal, outbox?: string) => Promise<string>;

export function linkedRoomMessages(links: ConversationLinks, bot: string,
  context: { room: string; event: MatrixEvent; key: string }, transport: {
    allowed(room: string, sender: string): Promise<boolean>;
    stopping(): boolean;
    continuePrivate?(id: string, target: BackgroundTarget, message: string): void;
    send(room: string, content: { msgtype: 'm.text'; body: string; format?: 'org.matrix.custom.html'; formatted_body?: string; 'm.mentions': { user_ids: string[] }; [GRANT]?: ReturnType<ConversationLinks['reserve']> | ReturnType<ConversationLinks['reserveMentions']> }): Promise<string>;
    read?(room: string, eventId: string): Promise<MatrixEvent | undefined>;
    receive?(event: MatrixEvent, key: string, signal: AbortSignal, authorize: () => Promise<void>): Promise<IncomingAttachment>;
    maxBytes?: number;
    sendFiles?(room: string, files: OutgoingAttachment[], signal: AbortSignal, authorize: () => Promise<void>): Promise<void>;
  }): MessageAction {
  return async (request, signal) => {
    // The agent's own DM with the same human is also a destination, so a result
    // that arrived in a shared room can be returned where the human asked for it.
    const home = links.agent(bot)?.home;
    const allowed = async (target: string) => {
      signal.throwIfAborted();
      const linked = () => (target === home || !!links.room(bot, target)) && links.key(bot, target, context.event) === context.key && !transport.stopping();
      if (!linked() || !(await transport.allowed(target, context.event.sender!)) || !linked()) {
        throw new DestinationUnavailable('Room message withheld: destination access, membership or privacy changed.');
      }
      signal.throwIfAborted();
    };
    if (request.action === 'list') {
      const rooms: { room: string; type: 'shared' | 'private'; agents?: string[] }[] = [];
      for (const target of [...links.sharedRooms(bot), ...home ? [home] : []]) {
        try { await allowed(target); rooms.push({ room: target, type: target === home ? 'private' : 'shared',
          ...(target !== home && { agents: links.bots(bot, target) }) }); }
        catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof DestinationUnavailable)) {
            throw new PublicError('Could not list linked rooms: destination access check failed.', { cause: error });
          }
        }
      }
      return JSON.stringify({ rooms });
    }
    if (request.action === 'continue_private') {
      if (!home || !links.room(bot, context.room) || !context.event.event_id || !transport.continuePrivate) {
        throw new PublicError('Private continuation requires a linked shared-room turn and a configured notification queue.');
      }
      await allowed(context.room);
      await allowed(home);
      const agent = links.agent(bot)!;
      const target: BackgroundTarget = { room: home, sender: agent.owner, key: context.key, session: agent.session,
        ...(agent.thread && { thread: agent.thread }) };
      const relation = context.event.content?.['m.relates_to'];
      const thread = relation?.rel_type === 'm.thread' ? relation.event_id : undefined;
      const id = 'continuation:' + createHash('sha256').update(JSON.stringify([bot, target, context.room, thread, request.id])).digest('hex');
      const message = 'Continue the existing task in your linked private chat after the shared-room turn. '
        + 'This is your own handoff note, not a new human request or approval. Inspect existing effects before continuing; '
        + 'do not repeat uncertain actions or reuse permissions from another room. Obtain any required approval here.\n'
        + JSON.stringify({ source_room: context.room, source_event: context.event.event_id, note: request.text });
      if (message.length > 4000) throw new PublicError('The continuation note and source references exceed 4000 characters. Shorten the note.');
      transport.continuePrivate(id, target, message);
      return JSON.stringify({ status: 'queued', room: home, continuation_id: id,
        note: 'End this shared-room turn. The same session will continue privately when idle; no approval or command was transferred.' });
    }
    await allowed(request.room);
    if (request.action === 'receive_attachment') {
      const shared = links.room(bot, request.room);
      if (!shared || !transport.read || !transport.receive) throw new PublicError('Attachment retrieval requires a linked shared room.');
      const event = await transport.read(request.room, request.event_id);
      await allowed(request.room);
      if (!event || event.event_id !== request.event_id || (event.room_id && event.room_id !== request.room) ||
          event.type !== 'm.room.message' || !links.participants(bot, request.room).includes(event.sender!) ||
          !isMedia(event.content?.msgtype) || !event.content?.file || event.content['m.relates_to']?.rel_type === 'm.replace') {
        throw new PublicError('No encrypted attachment found on that shared-room message.');
      }
      const file = await transport.receive(event, context.key, signal, () => allowed(request.room));
      // receive authorizes immediately before exposing plaintext. Once saved,
      // return its receipt: a later revocation cannot undo that completed read.
      return JSON.stringify({ status: 'received', room: request.room, event_id: request.event_id, file });
    }
    if (request.action === 'send_files') {
      if (!transport.sendFiles || transport.maxBytes === undefined) throw new PublicError('Room attachment delivery is not configured.');
      const delivery = attachmentDelivery(request.outbox, transport.maxBytes, (files, signal) =>
        transport.sendFiles!(request.room, files, signal, () => allowed(request.room)));
      const result = await delivery.action({ files: request.files }, signal);
      return JSON.stringify({ room: request.room, ...JSON.parse(result) });
    }
    const peers = links.bots(bot, request.room).filter(id => id !== bot);
    if ((request.mention || request.mentions?.length) && request.room === home) throw new PublicError('Room message withheld: mentions are only for other agents of a shared room.');
    if (request.mention && request.mentions !== undefined) throw new PublicError('Choose mention or mentions, not both.');
    if (request.mention && peers.length !== 1) throw new PublicError('Select recipients with mentions in a room with more than two agents.');
    const recipients = request.mention ? peers : [...new Set(request.mentions ?? [])];
    if (!recipients.every(id => peers.includes(id))) throw new PublicError('Only other agents of this shared room can be mentioned.');
    const grants = recipients.length ? links.reserveMentions(bot, request.room, recipients) : undefined;
    if (recipients.length && !grants) throw new PublicError('Room message withheld: no peer credit is available for all recipients. It is restored when the human next writes to you; select fewer recipients or send without mention.');
    // Use the running client's encryption state. Do not inherit private thread
    // relations, approvals or a human origin from the source room.
    const executorOrigin = request.text.startsWith('!exec ') ? links.executorOrigin(bot, context) : undefined;
    const eventId = await transport.send(request.room, {
      ...(recipients.length ? mentionContent(request.text, recipients.map(id => ({ id, name: links.displayName(id) })))
        : { msgtype: 'm.text' as const, body: request.text }),
      'm.mentions': { user_ids: recipients },
      ...(links.room(bot, request.room) && { [PEER_FIELD]: links.announcement(bot, request.room) }),
      ...(grants && { [GRANT]: grants.length === 1 ? grants[0] : grants }),
    });
    // Record executor correlation before returning the tool result, without
    // depending on a later sync echo (which may arrive after a fast completion).
    if (executorOrigin) {
      links.observe(bot, request.room, { type: 'm.room.message', sender: bot, event_id: eventId,
        content: { msgtype: 'm.text', body: request.text } });
      links.rememberExecutorOrigin(bot, request.room, eventId, executorOrigin);
    }
    return JSON.stringify({ status: 'sent', room: request.room, event_id: eventId });
  };
}

// Cache failures too: an uncertain send must never be repeated automatically.
// A configured receipt store extends this protection across turns and restarts.
export function roomMessageDelivery(send: MessageAction, receipts?: () => ScopedReceipts | Promise<ScopedReceipts>, maxBytes = 512 * 1024 * 1024): RoomMessageTool {
  const attempts = new Map<string, { content: string; result: Promise<string> }>();
  let continuationId: string | undefined;
  return async (input, signal, outbox) => {
    signal.throwIfAborted();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PublicError('Expected a room message request.');
    const r = input as Record<string, unknown>;
    if (r.action === 'list' && Object.keys(r).length === 1) return send({ action: 'list' }, signal);
    if (r.action === 'status' && Object.keys(r).every(k => ['action', 'id'].includes(k))) {
      if (!receipts) throw new PublicError('Persistent delivery receipts are not configured.');
      return (await receipts()).read(r.id as string | undefined);
    }
    if (r.action === 'continue_private') {
      if (Object.keys(r).some(k => !['action', 'text', 'id'].includes(k)) ||
          typeof r.text !== 'string' || !r.text.trim() || Buffer.byteLength(r.text, 'utf8') > 3000 || /[\x00-\x08\x0b-\x1f]/.test(r.text) ||
          typeof r.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(r.id)) {
        throw new PublicError('Use continue_private with a unique id and a handoff text of at most 3000 UTF-8 bytes. The destination is your own linked private chat.');
      }
      if (continuationId !== undefined && continuationId !== r.id) throw new PublicError('Only one private continuation may be requested per turn. Inspect its receipt instead of creating another.');
      continuationId = r.id;
      return attempt(r.id, { action: 'continue_private', id: r.id, text: r.text }, signal);
    }
    const roomValid = typeof r.room === 'string' && /^![^\s:]+:[^\s]+$/.test(r.room);
    if (r.action === 'receive_attachment') {
      if (!roomValid || Object.keys(r).some(k => !['action', 'room', 'event_id'].includes(k)) ||
          typeof r.event_id !== 'string' || !/^\$[^\s]{1,1023}$/.test(r.event_id)) {
        throw new PublicError('Use receive_attachment with a linked shared room and an exact Matrix event_id.');
      }
      return send({ action: 'receive_attachment', room: r.room as string, event_id: r.event_id }, signal);
    }
    if (r.action === 'send_files') {
      if (!roomValid || !outbox || Object.keys(r).some(k => !['action', 'room', 'id', 'files'].includes(k)) ||
          typeof r.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(r.id) || !Array.isArray(r.files) || !r.files.length ||
          r.files.some(f => !f || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).some(k => !['path', 'name'].includes(k)))) {
        throw new PublicError('Use send_files with room, a unique id and files from the current outbox.');
      }
      outgoingAttachments({ files: r.files }, outbox);
      const files = r.files.map(file => ({ path: file.path as string, ...(file.name !== undefined && { name: file.name as string }) }));
      return attempt(r.id, { action: 'send_files', room: r.room as string, id: r.id, files, outbox }, signal);
    }
    if (r.action !== 'send' || Object.keys(r).some(k => !['action', 'room', 'text', 'id', 'mention', 'mentions'].includes(k)) ||
        typeof r.room !== 'string' || !/^![^\s:]+:[^\s]+$/.test(r.room) ||
        typeof r.text !== 'string' || !r.text.trim() || Buffer.byteLength(r.text, 'utf8') > (r.mention || r.mentions !== undefined ? 6000 : 8000) ||
        typeof r.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(r.id) || (r.mention !== undefined && typeof r.mention !== 'boolean') ||
        (r.mentions !== undefined && (!Array.isArray(r.mentions) || !r.mentions.length || r.mentions.length > PEER_CREDIT ||
          !r.mentions.every(id => typeof id === 'string' && /^@[^\s:]+:[^\s]+$/.test(id)))) ||
        (r.mention !== undefined && r.mentions !== undefined)) {
      // A mentioning message must fit whole into the notice that quotes it.
      throw new PublicError('Use action=list, or action=send with room, text (up to 8000 UTF-8 bytes, or 6000 with mention), a unique id (letters, digits, underscore or hyphen; up to 80 characters) and optional mentions (recipient Matrix IDs), or mention=true for a two-agent room.');
    }
    const request: MessageRequest = { action: 'send', room: r.room, text: r.text, id: r.id, ...(r.mention && { mention: true }),
      ...(r.mentions !== undefined && { mentions: [...r.mentions as string[]] }) };
    return attempt(r.id, request, signal);
  };
  async function attempt(id: string, request: MessageRequest, signal: AbortSignal) {
    const content = request.action === 'send_files' && receipts
      ? JSON.stringify({ action: request.action, room: request.room, files: await attachmentFingerprint(outgoingAttachments({ files: request.files }, request.outbox), maxBytes) })
      : JSON.stringify(request);
    signal.throwIfAborted();
    const store = await receipts?.();
    signal.throwIfAborted();
    const previous = attempts.get(id);
    if (previous) {
      if (previous.content !== content) throw new PublicError('This message id was already used with different content.');
      return previous.result;
    }
    if (attempts.size >= 32) throw new PublicError('Room message limit reached for this turn.');
    const result = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return store ? store.run(id, content, () => send(request, signal)) : send(request, signal);
    });
    attempts.set(id, { content, result });
    return result;
  }
}
