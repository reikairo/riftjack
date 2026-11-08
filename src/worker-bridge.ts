import type { ConversationLinks } from './conversation-links.js';
import { randomUUID } from 'node:crypto';
import { AGENT_TRIGGER, sessionKey, type MatrixEvent } from './bridge.js';
import { isMedia } from './media.js';
import type { State } from './state.js';
import { WorkerError, type WorkerQueue, type WorkerTask } from './worker-queue.js';
import type { WorkerService } from './worker-service.js';
import { reactionFeedback, type ReactionReader } from './reaction-feedback.js';

export class WorkerBridge {
  private stopped = false;
  constructor(private options: { botId: string; authorized: (sender: string) => boolean;
    privateRoom: (room: string, sender: string) => Promise<boolean>; queue: WorkerQueue;
    reactionTarget?: ReactionReader; links?: ConversationLinks; since?: number;
    service: WorkerService; state: State; reply: (room: string, event: MatrixEvent, text: string) => Promise<void> }) {}
  get busy() { return this.options.service.busy; }
  stop() { this.stopped = true; this.options.service.stop(); }
  revoke(sender: string) { this.options.queue.cancelWhere(task => task.event.sender === sender); }
  async handle(room: string, event: MatrixEvent) {
    const o = this.options, links = o.links, shared = links?.room(o.botId, room);
    if (this.stopped) return;
    if (shared) {
      if (!Number.isFinite(event.origin_server_ts) || event.origin_server_ts! < (o.since ?? 0) ||
          !o.authorized(shared.owner) || !(await o.privateRoom(room, shared.owner))) return;
      links!.observe(o.botId, room, event);
      if (event.sender !== shared.owner) {
        links!.mention(o.botId, room, event, notice => this.enqueue(room, notice));
        return;
      }
      if (!links!.addressed(o.botId, room, event)) return;
    }
    if (event.type === 'm.reaction') {
      if (this.stopped || !o.reactionTarget) return;
      const feedback = await reactionFeedback(room, event, { botId: o.botId, authorized: o.authorized,
        privateRoom: o.privateRoom, read: o.reactionTarget });
      if (!feedback) return;
      event = feedback;
    }
    if (this.stopped || event.type !== 'm.room.message' || !event.event_id || !event.sender ||
      event.sender === o.botId || !o.authorized(event.sender) || !event.content ||
      (event.content.msgtype !== 'm.text' && !isMedia(event.content.msgtype)) ||
      event.content['m.relates_to']?.rel_type === 'm.replace') return;
    if (!(await o.privateRoom(room, event.sender)) || !o.authorized(event.sender)) return;
    const key = links ? links.key(o.botId, room, event) : sessionKey(room, event);
    const body = event.content.body?.trim() || '';
    if (event.content.msgtype === 'm.text' && body.startsWith('!')) {
      // Control events use the same durable deduplication as ordinary messages.
      const command = o.queue.enqueue(room, event, key, true);
      if (command.status === 'cancelled' || command.status === 'delivered') return;
      if (body === '!reset' && links) {
        o.queue.cancel(command.id);
        await o.reply(room, event, 'This agent continues a pinned session across linked rooms. Reset is disabled; explicitly reconfigure its session link to replace that history.');
      } else if (body === '!cancel' || body === '!reset') {
        o.queue.cancelWhere(task => task.room === room && task.event.sender === event.sender && task.conversation.startsWith(key + '\n') && sessionKey(task.room, task.event) === sessionKey(room, event));
        if (body === '!reset') o.state.update(key, { grok: randomUUID() });
        o.queue.cancel(command.id);
        await o.reply(room, event, body === '!reset' ? 'New worker conversation started. Previous tasks were cancelled.' : 'Queued tasks and leases cancelled. The remote worker must observe cancellation; completed actions are not undone.');
      } else if (body === '!status') {
        const tasks = o.queue.list().filter(task => task.conversation.startsWith(key + '\n'));
        o.queue.cancel(command.id);
        const queued = tasks.filter(task => task.status === 'queued' || (task.status === 'leased' && task.leaseUntil! <= Date.now())).length;
        const working = tasks.filter(task => task.status === 'leased' && task.leaseUntil! > Date.now()).length;
        const sending = tasks.filter(task => task.status === 'replied').length;
        await o.reply(room, event, `Grok · external worker\nModel, reasoning, speed and workspace: managed by the worker; not reported to Riftjack.\nQueued: ${queued}. Leased to a worker: ${working}. Replies awaiting delivery: ${sending}.`);
      } else {
        o.queue.cancel(command.id);
        await o.reply(room, event, 'Send text, images, files or audio to the connected Grok worker. Messages are queued durably, including while it is offline.\n!status — show queued work and replies.\n!cancel — cancel this conversation’s queued work.\n!reset — start a new worker conversation.\nThe worker handles its own model context and tool permissions. Use Bot Manager for !restart.');
      }
      return;
    }
    if (body.length > 16_000) { await o.reply(room, event, 'Messages must be at most 16,000 characters.'); return; }
    this.enqueue(room, event);
  }
  private enqueue(room: string, event: MatrixEvent) {
    const o = this.options, links = o.links;
    const key = links ? links.key(o.botId, room, event) : sessionKey(room, event);
    let conversation = o.state.session(key).grok;
    if (!conversation) { conversation = randomUUID(); o.state.update(key, { grok: conversation }); }
    const fresh = !o.queue.hasEvent(event.event_id!);
    const shared = links?.room(o.botId, room);
    const context = { room, type: shared ? 'shared' as const : 'private' as const, agents: links?.bots(o.botId, room) ?? [],
      key, session: conversation, binding: workerBinding(links, o.botId, room) };
    o.queue.enqueue(room, event, key + '\n' + conversation, false, context);
    if (fresh && !event.content?.[AGENT_TRIGGER]) links?.credit(o.botId);
  }
}

// Snapshot configuration, not live Matrix state (which is checked on every use).
export function workerBinding(links: ConversationLinks | undefined, bot: string, room: string): string {
  return JSON.stringify([links?.agent(bot) ?? null, links?.room(bot, room) ?? null]);
}

export async function workerTaskAllowed(task: WorkerTask, options: {
  bot: string; links?: ConversationLinks; state: State; stopping(): boolean;
  allowed(room: string, sender: string): Promise<boolean>;
}): Promise<boolean> {
  const { links, bot, state } = options;
  const valid = () => {
    if (options.stopping()) throw new WorkerError(503, 'Connector is stopping.');
    let key: string;
    try { key = links ? links.key(bot, task.room, task.event) : sessionKey(task.room, task.event); }
    catch { return false; } // A missing/replaced pinned session cannot run.
    const session = state.session(key).grok;
    return !!session && task.conversation === key + '\n' + session &&
      (!links || !!task.context) && (!task.context || task.context.binding === workerBinding(links, bot, task.room));
  };
  // Network failures are retryable, not evidence that access was revoked.
  return valid() && await options.allowed(task.room, task.event.sender!) && valid();
}
