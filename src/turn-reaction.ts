import type { State } from './state.js';

type Transport = {
  send: (room: string, eventId: string) => Promise<string>;
  remove: (room: string, reactionId: string) => Promise<unknown>;
};

// One marker in the reply room and, for linked agents, one in their private home.
export class TurnReaction {
  private revision = 0;
  private tail: Promise<void> = Promise.resolve();
  private unsaved: { room: string; eventId: string }[] = [];
  constructor(private state: State, private bot: string, private transport: Transport, private home?: string) {}

  rememberReply(room: string, eventId: string) {
    if (room === this.home) this.state.saveHomeReply(this.bot, { room, eventId });
  }

  private serialize(action: () => Promise<void>) {
    const task = this.tail.then(action);
    this.tail = task.catch(() => {});
    return task;
  }

  private async clear() {
    const errors: unknown[] = [];
    const markers = this.state.turnReactions(this.bot);
    for (const marker of this.unsaved) {
      if (!markers.some(saved => saved.room === marker.room && saved.eventId === marker.eventId)) markers.push(marker);
    }
    for (const marker of markers) {
      try {
        await this.transport.remove(marker.room, marker.eventId);
        this.unsaved = this.unsaved.filter(saved => saved.room !== marker.room || saved.eventId !== marker.eventId);
        this.state.saveTurnReactions(this.bot, this.state.turnReactions(this.bot)
          .filter(saved => saved.room !== marker.room || saved.eventId !== marker.eventId));
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Could not remove task activity reactions');
  }

  started() {
    ++this.revision;
    return this.serialize(() => this.clear());
  }

  completed(room: string, eventId: string, allowed: (room: string) => Promise<boolean>) {
    this.rememberReply(room, eventId);
    const revision = this.revision;
    return this.serialize(async () => {
      await this.clear();
      const home = this.state.homeReply(this.bot);
      const targets = [{ room, eventId }];
      if (home && home.room === this.home && home.room !== room) targets.push(home);
      for (const target of targets) {
        if (revision !== this.revision) break;
        if (!(await allowed(target.room))) continue;
        if (revision !== this.revision) break;
        const reactionId = await this.transport.send(target.room, target.eventId);
        // Retain the remote receipt until it is durable or successfully redacted.
        // A failed save must not leave a marker that later turns cannot clear.
        this.unsaved.push({ room: target.room, eventId: reactionId });
        try {
          this.state.saveTurnReactions(this.bot, [...this.state.turnReactions(this.bot), ...this.unsaved]);
          this.unsaved = [];
        } catch (error) {
          try { await this.clear(); }
          catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Could not save or remove task activity reactions');
          }
          throw error;
        }
        // A new task or queued update can arrive while either send is in flight.
        if (revision !== this.revision || !(await allowed(target.room)) || revision !== this.revision) {
          await this.clear(); break;
        }
      }
      for (const marker of this.state.turnReactions(this.bot)) {
        if (revision !== this.revision || !(await allowed(marker.room)) || revision !== this.revision) {
          await this.clear(); break;
        }
      }
    });
  }
}
