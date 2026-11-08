import { randomUUID } from 'node:crypto';
import { PEER_EVENT, PEER_FIELD, type ConversationLinks } from './conversation-links.js';

export type DiscoveryEvent = { type?: string; sender?: string; event_id?: string; room_id?: string;
  origin_server_ts?: number; content?: Record<string, unknown> };

// These encrypted protocol events never enter a model turn or replenish credit.
// Periodic requests repair missed announcements; responses never request a reply.
export class PeerDiscovery {
  private due = new Map<string, number>();
  private responded = new Map<string, number>();
  private busy = false;
  constructor(private links: ConversationLinks, private bot: string, private transport: {
    allowed(room: string, owner: string): Promise<boolean>;
    send(room: string, type: string, content: Record<string, unknown>): Promise<unknown>;
    stopping(): boolean;
    report(error: unknown): void;
  }, private now = Date.now) {}
  changed(room: string) { if (this.links.room(this.bot, room)) this.due.set(room, 0); }
  async pump() {
    if (this.busy || this.transport.stopping()) return;
    this.busy = true;
    try {
      for (const room of this.links.sharedRooms(this.bot)) {
        if (this.transport.stopping()) break;
        if ((this.due.get(room) ?? 0) > this.now()) continue;
        // Retry at the next pump after failures; success needs only a slow refresh.
        this.due.set(room, this.now() + 30_000);
        try {
          if (await this.announce(room, { request: randomUUID() })) this.due.set(room, this.now() + 300_000);
        } catch (error) { this.transport.report(error); }
      }
    } finally { this.busy = false; }
  }
  // Only WorkerMatrixClient's decrypted-event hook may call this method.
  async receive(room: string, event: DiscoveryEvent) {
    if (this.transport.stopping() || (event.type !== PEER_EVENT && !event.content?.[PEER_FIELD])) return;
    const shared = this.links.room(this.bot, room);
    if (!shared || !(await this.transport.allowed(room, shared.owner)) || this.transport.stopping()) return;
    if (!this.links.learnPeer(this.bot, room, event, this.now()) || event.type !== PEER_EVENT) return;
    const request = event.content?.request;
    if (typeof request !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(request) || event.content?.response !== undefined) return;
    const key = JSON.stringify([room, event.sender]);
    const now = this.now();
    this.responded = new Map([...this.responded].filter(([, until]) => until > now));
    if (this.responded.has(key) || this.responded.size >= 1024) return;
    this.responded.set(key, now + 30_000);
    try { await this.announce(room, { response: request }); }
    catch (error) { this.transport.report(error); }
  }
  private async announce(room: string, extra: Record<string, string>) {
    const hello = this.links.announcement(this.bot, room);
    if (!hello || this.transport.stopping() || !(await this.transport.allowed(room, hello.owner)) || this.transport.stopping()) return false;
    await this.transport.send(room, PEER_EVENT, { ...hello, ...extra });
    return true;
  }
}
