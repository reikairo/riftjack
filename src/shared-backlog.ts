import type { ConversationLinks } from './conversation-links.js';
import type { MatrixEvent } from './bridge.js';

// Observations are already durable in ConversationLinks. There is no second
// message queue here; normal turns may consume the batch before admission.
export class SharedBacklog {
  private running = false;
  constructor(private links: ConversationLinks, private bot: string, private transport: {
    idle(): boolean;
    deliver(room: string, event: MatrixEvent, session: string, admitted: () => void, ready: () => boolean): Promise<boolean>;
  }) {}
  async pump(): Promise<void> {
    if (this.running || !this.transport.idle()) return;
    this.running = true;
    try {
      const skipped = new Set<string>();
      while (this.transport.idle()) {
        const next = this.links.backlog(this.bot, skipped);
        if (!next) return;
        let admitted = false;
        await this.transport.deliver(next.room, next.event, next.session,
          () => { this.links.backlogAdmitted(this.bot, next.room, next.event.event_id!); admitted = true; },
          () => this.transport.idle() && this.links.backlog(this.bot, skipped)?.event.event_id === next.event.event_id);
        if (admitted) return;
        // An inaccessible room must not prevent another linked room's delivery.
        skipped.add(next.room);
      }
    } finally { this.running = false; }
  }
}
