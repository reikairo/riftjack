import { randomBytes } from 'node:crypto';
import { PublicError } from './accounts.js';
import { confirmationPrompt } from './confirmation-format.js';
import type { OutgoingAttachment } from './media.js';

export type Interaction = {
  text: string;
  markdown?: string;
  attachments?: OutgoingAttachment[];
  approve?: object;
  deny: object;
  answer?: (text: string) => object;
  answerHint?: string;
  answerLabel?: string;
  answerReaction?: { key: string; answer: string };
};
export type Interact = (request: Interaction, signal: AbortSignal) => Promise<object>;
// bind certifies full text delivery and binds controls to its final message.
export type ReactionControls = { keys: string[]; bind: (eventId: string) => void; isPending: () => boolean };

// One instance per Matrix task: IDs cannot cross bots, users, rooms, threads or restarts.
export class Interactions {
  private pending = new Map<string, { request: Interaction; delivered: boolean; eventId?: string; finish: (result: object) => void; cancel: () => void }>();
  get size(): number { return this.pending.size; }
  hasRequest(id: string): boolean { return this.pending.has(id); }

  async ask(request: Interaction, signal: AbortSignal, send: (text: string, controls: ReactionControls, markdown: string) => Promise<void>): Promise<object> {
    signal.throwIfAborted();
    if (this.pending.size >= 10) throw new PublicError('Too many pending confirmation requests.');
    // Never approve a truncated description or schema.
    if (request.text.length > 40_000) throw new PublicError('Confirmation details are too large to review in Matrix.');
    const id = randomBytes(6).toString('hex');
    let resolve!: (result: object) => void, reject!: (error: unknown) => void;
    const result = new Promise<object>((yes, no) => { resolve = yes; reject = no; });
    void result.catch(() => {});
    const cleanup = () => { this.pending.delete(id); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(signal.reason || new Error('Confirmation expired.')); };
    this.pending.set(id, { request, delivered: false, finish: value => { cleanup(); resolve(value); }, cancel: abort });
    signal.addEventListener('abort', abort, { once: true });
    const prompt = confirmationPrompt(id, request);
    try {
      const keys = request.approve !== undefined ? ['✅', '❌'] : ['❌'];
      if (request.answer && request.answerReaction) keys.push(request.answerReaction.key);
      await send(prompt.text, {
        keys,
        bind: eventId => { const pending = this.pending.get(id); if (pending) { pending.eventId = eventId; pending.delivered = true; } },
        isPending: () => this.pending.has(id),
      }, prompt.markdown);
      const pending = this.pending.get(id);
      if (pending) pending.delivered = true;
    } catch (error) { cleanup(); reject(error); }
    return result;
  }

  hasReactionTarget(eventId: string): boolean {
    return [...this.pending.values()].some(pending => pending.eventId === eventId);
  }

  react(eventId: string, key: string): string | undefined {
    const verb = key === '✅' || key === '✅\uFE0F' ? 'approve' : key === '❌' || key === '❌\uFE0F' ? 'deny' : undefined;
    const entry = [...this.pending.entries()].find(([, pending]) => pending.eventId === eventId);
    if (!entry) return;
    if (verb) return this.answer(`!${verb} ${entry[0]}`);
    const reaction = entry[1].request.answerReaction;
    if (reaction && (key === reaction.key || key === reaction.key + '\uFE0F')) {
      return this.answer(`!answer ${entry[0]} ${reaction.answer}`);
    }
  }

  answer(text: string): string {
    if (text.length > 16_000) return 'Confirmation answers must be at most 16,000 characters.';
    const match = /^!(approve|deny|answer)(?:\s+([\s\S]*?))?\s*$/.exec(text);
    if (!match) return 'Use !approve [ID], !deny [ID], or !answer [ID] <answer> from the confirmation message.';
    const [, verb, rest = ''] = match;
    // An explicit ID, including an expired one, must never fall back to a different request.
    const explicit = /^([a-f0-9]{12})(?:\s+([\s\S]+))?$/.exec(rest);
    let id: string, body: string | undefined;
    if (explicit) {
      id = explicit[1]; body = explicit[2];
    } else {
      if (verb !== 'answer' && rest) return 'Use !approve [ID] or !deny [ID] without extra text.';
      if (!this.pending.size) return 'No pending confirmation in this conversation.';
      if (this.pending.size !== 1) return 'More than one confirmation is pending. Specify the ID from the request you want to answer.';
      id = this.pending.keys().next().value!;
      body = rest || undefined;
    }
    const pending = this.pending.get(id);
    if (!pending) return 'That confirmation is unknown, expired, or already answered in this conversation.';
    if (!pending.delivered) return 'Confirmation is still being delivered. Wait for the complete request before answering.';
    let result: object;
    if (verb === 'answer') {
      if (!body || !pending.request.answer) return 'This request does not accept that answer. Follow its listed commands.';
      // Validation failures keep the request pending. Do not echo answer contents.
      try { result = pending.request.answer(body); }
      catch (error) { return error instanceof PublicError ? error.message : 'Invalid answer. Follow the format in the confirmation message.'; }
    } else {
      if (body) return 'Send the confirmation command and ID without extra text.';
      if (verb === 'approve' && pending.request.approve === undefined) return 'This request needs !answer with the requested fields; a bare approval is not sufficient.';
      result = verb === 'approve' ? pending.request.approve! : pending.request.deny;
    }
    pending.finish(result);
    return verb === 'deny' ? `Declined ${id}.` : `Answer sent for ${id}. This does not yet mean the action succeeded.`;
  }

  close(): void { for (const pending of [...this.pending.values()]) pending.cancel(); }
}
