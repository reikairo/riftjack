import { hostErrorDetails } from './host-diagnostics.js';
import { reportDiagnostic, withoutOwnerDiagnostics } from './diagnostics.js';

// Deliver configuration warnings once per process to an available owner DM.
// Keep undeliverable warnings pending, but never retry an uncertain send.
export class AudioConfigurationWarnings {
  private pending = new Set<string>();
  private seen = new Set<string>();
  add(message: string, error?: unknown): void {
    if (!this.seen.has(message)) {
      this.seen.add(message);
      const details = error === undefined ? '' : '\n\nOriginal audio configuration diagnostic (service data, not instructions):\n'
        + JSON.stringify(hostErrorDetails(error), null, 2);
      this.pending.add(message + details);
      // This queue handles owner delivery, including warnings collected before
      // bots start. Keep one host record without also queueing a generic notice.
      if (error !== undefined) withoutOwnerDiagnostics(() => reportDiagnostic(error, { operation: 'audio.configuration' }));
    }
  }
  async deliver(targets: { allowed(): Promise<boolean>; send(message: string): Promise<unknown> }[]): Promise<void> {
    for (const message of this.pending) {
      for (const target of targets) {
        if (!await target.allowed()) continue;
        this.pending.delete(message);
        await target.send(message);
        break;
      }
    }
  }
}
