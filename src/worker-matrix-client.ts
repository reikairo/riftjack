import { RateLimitedMatrixClient } from './rate-limited-matrix-client.js';

// Unlike model tasks, durable inbox writes must finish before saving /sync's
// next_batch. Failures keep the previous checkpoint on disk for restart replay.
export class WorkerMatrixClient extends RateLimitedMatrixClient {
  inbox?: (room: string, event: any) => Promise<void>;
  protocol?: (room: string, event: any) => Promise<void>;
  private decrypted = new WeakSet<object>();
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
        } catch (error) { this.stop(); this.emit('worker.inbox_failure', error); throw error; }
      }
      this.emit(type, ...args);
    });
  }
}
