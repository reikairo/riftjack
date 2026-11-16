import { RateLimitedMatrixClient } from './rate-limited-matrix-client.js';

type FailedDecryption = { room: string; event: string };
const FAILED_DECRYPTIONS = 'riftjack.worker.failed_decryptions.v1';
const MAX_FAILED_DECRYPTIONS = 1000;
const RETRY_BATCH_SIZE = 50;

// Unlike model tasks, durable inbox writes must finish before saving /sync's
// next_batch. Failures keep the previous checkpoint on disk for restart replay.
export class WorkerMatrixClient extends RateLimitedMatrixClient {
  inbox?: (room: string, event: any) => Promise<void>;
  protocol?: (room: string, event: any) => Promise<void>;
  private decrypted = new WeakSet<object>();
  private failures?: FailedDecryption[];
  private inboxFailureReported = false;

  private async failedDecryptions() {
    if (this.failures) return this.failures;
    const saved = await Promise.resolve(this.storageProvider.readValue(FAILED_DECRYPTIONS));
    const parsed: unknown = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(parsed) || parsed.length > MAX_FAILED_DECRYPTIONS ||
        parsed.some(item => !item || typeof item !== 'object' ||
          typeof item.room !== 'string' || !item.room.startsWith('!') ||
          typeof item.event !== 'string' || !item.event.startsWith('$'))) {
      throw new Error('Invalid failed-decryption journal; restore Matrix storage instead of discarding it.');
    }
    return this.failures = parsed as FailedDecryption[];
  }

  private async saveFailedDecryptions(failures: FailedDecryption[]) {
    await Promise.resolve(this.storageProvider.storeValue(FAILED_DECRYPTIONS, JSON.stringify(failures)));
    this.failures = failures;
  }

  private async rememberFailedDecryption(room: string, event: any) {
    if (!room.startsWith('!') || typeof event?.event_id !== 'string' || !event.event_id.startsWith('$')) return;
    const failures = await this.failedDecryptions();
    if (failures.some(item => item.room === room && item.event === event.event_id)) return;
    if (failures.length === MAX_FAILED_DECRYPTIONS) {
      throw new Error('Failed-decryption journal is full; restore room keys before resuming sync.');
    }
    await this.saveFailedDecryptions([...failures, { room, event: event.event_id }]);
  }

  private async retryFailedDecryptions(emit: (type: string, ...args: any[]) => Promise<any>) {
    const failures = await this.failedDecryptions();
    const batch = failures.slice(0, RETRY_BATCH_SIZE), pending: FailedDecryption[] = [];
    for (const item of batch) {
      let event: any;
      try {
        const found = await this.getEvent(item.room, item.event);
        event = found?.raw ?? found;
      } catch {
        // Missing keys and temporary fetch failures remain durable for retry.
        pending.push(item); continue;
      }
      if (!event || event.type === 'm.room.encrypted') { pending.push(item); continue; }
      // Use the ordinary admission path, including peer discovery before inbox.
      // Admission failures must escape, retaining the journal and sync token.
      await emit('room.decrypted_event', item.room, event);
      if (event.type === 'm.room.message') await emit('room.message', item.room, event);
      await emit('room.event', item.room, event);
    }
    // Rotate unavailable entries so one missing key cannot starve later events.
    if (pending.length !== batch.length || failures.length > batch.length) {
      await this.saveFailedDecryptions([...failures.slice(batch.length), ...pending]);
    }
  }

  protected override async processSync(raw: any, emitFn?: (type: string, ...args: any[]) => Promise<any>) {
    const emit = emitFn ?? (async (type: string, ...args: any[]) => { this.emit(type, ...args); });
    try {
      const pendingBefore = (await this.failedDecryptions()).length;
      await super.processSync(raw, async (type, ...args) => {
        if (type === 'room.failed_decryption') await this.rememberFailedDecryption(args[0], args[1]);
        await emit(type, ...args);
      });
      // The SDK processes to-device room keys before room timelines. Also retry
      // on the first sync after restart, when the key may already be stored.
      if (pendingBefore || raw?.to_device?.events?.length) await this.retryFailedDecryptions(emit);
    } catch (error) { this.stopForInboxFailure(error); throw error; }
  }

  protected stopForInboxFailure(error: unknown): void {
    // Nested sync processing can catch the same failure again. One stopped
    // client must request shutdown only once, with its original failure.
    if (this.inboxFailureReported) return;
    this.inboxFailureReported = true;
    this.stop(); this.emit('worker.inbox_failure', error);
  }
  protected override async startSyncInternal() {
    this.persistTokenAfterSync = true;
    return this.startSync(async (type, ...args) => {
      if (type === 'room.decrypted_event' && args[1] && typeof args[1] === 'object') this.decrypted.add(args[1]);
      if (type === 'room.message' || (type === 'room.event' && args[1]?.type !== 'm.room.message')) {
        try {
          // Run outside the SDK's decryption try/catch, before routing a message.
          // A failed durable discovery write must not advance the sync checkpoint.
          if (this.decrypted.has(args[1])) await this.protocol?.(args[0], args[1]);
          if (type === 'room.message' || args[1]?.type === 'm.reaction') await this.inbox?.(args[0], args[1]);
        } catch (error) { this.stopForInboxFailure(error); throw error; }
      }
      this.emit(type, ...args);
    });
  }
}
