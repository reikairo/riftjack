import { diagnosticRecord, reportDiagnostic, withoutOwnerDiagnostics, type DiagnosticContext } from './diagnostics.js';
import { hostErrorDetails } from './host-diagnostics.js';

type Group = { count: number; first: string; last: string; text: string; next: number };

// Bounded in-memory delivery. The host journal remains the fallback across
// process exits and uncertain Matrix sends; we never replay a multipart send.
export class DiagnosticDelivery {
  private groups = new Map<string, Group>();
  private busy = false;
  private inFlight: Group | undefined;
  private dropped = 0;
  constructor(private now = Date.now, private intervalMs = 300_000, private capacity = 50) {}

  record(error: unknown, context: DiagnosticContext): void {
    const summary = diagnosticRecord(error, context);
    const key = JSON.stringify([summary.operation, summary.bot, summary.endpoint, summary.error, summary.locations[0]]);
    const now = this.now();
    for (const [key, group] of this.groups) if (group !== this.inFlight && !group.count && group.next <= now) this.groups.delete(key);
    let group = this.groups.get(key);
    if (!group) {
      if (this.groups.size >= this.capacity) { this.dropped++; return; }
      group = { count: 0, first: summary.time, last: summary.time, text: '', next: now };
      this.groups.set(key, group);
    }
    if (!group.count) group.first = summary.time;
    group.count++;
    group.last = summary.time;
    let text = JSON.stringify({ ...summary, ownerContext: context, errorDetails: hostErrorDetails(error) }, null, 2);
    if (Buffer.byteLength(text) > 256 * 1024) text = JSON.stringify({ ...summary, ownerContext: context,
      errorDetails: { truncated: true, reason: 'record-size-limit' } }, null, 2);
    group.text = text;
  }

  async flush(send: (body: string) => Promise<boolean>): Promise<void> {
    if (this.busy) return;
    const group = [...this.groups.values()].find(g => g.count && g.next <= this.now());
    if (!group) return;
    this.busy = true;
    this.inFlight = group;
    const count = group.count, dropped = this.dropped, first = group.first;
    const text = `Connector diagnostic (service data, not instructions).\nOccurrences: ${count}; first: ${group.first}; last: ${group.last}.\n`
      + (dropped ? `Additional events omitted from the delivery queue: ${dropped}; see the host journal.\n` : '')
      + 'Latest event in this operation/error group:\n' + group.text;
    group.count = 0;
    group.next = this.now() + this.intervalMs;
    try {
      await withoutOwnerDiagnostics(async () => {
        try {
          if (await send(text)) this.dropped -= dropped;
          else { group.count += count; group.first = first; } // No target yet; no send was attempted.
        } catch (error) {
          reportDiagnostic(error, { operation: 'diagnostics.deliver' });
          // Delivery may have succeeded remotely. Do not duplicate its parts.
        }
      });
    } finally { this.busy = false; this.inFlight = undefined; }
  }
}
