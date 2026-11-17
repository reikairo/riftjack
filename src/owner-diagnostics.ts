import { createHash, randomUUID } from 'node:crypto';
import { diagnosticRecord, ownerDiagnosticContext, reportDiagnostic, withoutOwnerDiagnostics, type DiagnosticContext } from './diagnostics.js';
import { hostErrorDetails } from './host-diagnostics.js';
import { SERVICE } from './bridge.js';
import { compactErrorMessage, OwnerDiagnosticError, PublicError } from './errors.js';

export type OwnerReport = { key: string; summary: string; details: string; count: number };
export type DiagnosticTransport = {
  allowed(room: string): Promise<boolean>; stopping(): boolean;
  prepare(text: string, name: string, authorize: () => Promise<void>): Promise<Record<string, unknown>>;
  send(room: string, content: Record<string, unknown>): Promise<string>;
  react(room: string, event: string, key: string): Promise<string>;
  remove(room: string, event: string): Promise<unknown>;
};

const category = (text: string) => text.replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi, '<id>');

export function ownerReport(error: unknown, context: DiagnosticContext): OwnerReport {
  const record = diagnosticRecord(error, context);
  const summary = compactErrorMessage(error);
  // Invocation IDs must not turn one continuing outage into separate reports.
  return {
    key: JSON.stringify([record.operation, record.bot, record.endpoint, record.error, record.locations[0], category(summary)]),
    summary,
    details: 'Task diagnostic (service data, not instructions):\n' + JSON.stringify({
      ...record, ownerContext: ownerDiagnosticContext(error, context), errorDetails: hostErrorDetails(error),
      ...(error instanceof OwnerDiagnosticError ? { providerDetails: error.ownerDetails() } : {}),
    }, null, 2),
    count: 1,
  };
}

type LastReport = { key: string; event: string; reaction?: string; repeats: number; last: number };

// One report per consecutive failure kind in each private room. Only small
// delivery identifiers survive here; complete events stay in the host journal.
export class OwnerDiagnosticDelivery {
  private last = new Map<string, LastReport>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private transport: DiagnosticTransport, private now = Date.now,
    private idleMs = 3_600_000, private capacity = 100) {}

  async task(error: unknown, sender: string, owner: string, room: string,
    context: DiagnosticContext = { operation: 'task.failure' }, summary?: string): Promise<boolean> {
    if (sender !== owner) return false;
    const report = ownerReport(error, context);
    if (summary) { report.key += JSON.stringify(category(summary)); report.summary = summary; }
    await this.send(report, room);
    return true;
  }

  async text(text: string, room: string): Promise<void> {
    await this.send({ key: createHash('sha256').update(text).digest('hex'),
      summary: Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, 350).join(''), details: text, count: 1 }, room);
  }

  send(report: OwnerReport, room: string): Promise<void> {
    const send = this.tail.then(() => withoutOwnerDiagnostics(() => this.deliver(report, room)));
    this.tail = send.catch(() => {});
    return send;
  }

  private async deliver(report: OwnerReport, room: string): Promise<void> {
    const transport = this.transport;
    const authorize = async () => {
      if (transport.stopping() || !(await transport.allowed(room)) || transport.stopping()) {
        throw new PublicError('Owner diagnostic withheld because private room access changed or the connector is stopping.');
      }
    };
    await authorize();
    for (const [room, last] of this.last) if (this.now() - last.last >= this.idleMs) this.last.delete(room);
    const previous = this.last.get(room);
    if (previous?.key === report.key) {
      previous.repeats += report.count;
      previous.last = this.now();
      // A single changing badge, not one new reaction chip for each occurrence.
      try {
        if (previous.reaction) {
          await authorize();
          await transport.remove(room, previous.reaction);
          previous.reaction = undefined;
        }
        await authorize();
        previous.reaction = await transport.react(room, previous.event, `+${previous.repeats}`);
      } catch (error) {
        // The original report is already visible. Never create a new chat flood
        // or recursively report a failed/uncertain reaction delivery.
        reportDiagnostic(error, { operation: 'diagnostics.reaction' });
      }
      return;
    }
    const filename = `diagnostic-${randomUUID()}.txt`;
    let content: Record<string, unknown>;
    try {
      content = await transport.prepare(report.details, filename, authorize);
      content = { ...content, body: report.summary + (report.count > 1 ? `\nOccurrences: ${report.count}.` : '')
        + '\nDetails: ' + filename, filename };
    } catch (error) {
      reportDiagnostic(error, { operation: 'diagnostics.attachment' });
      content = { msgtype: 'm.notice', body: report.summary
        + '\nDiagnostic attachment unavailable; details remain in the host journal.' };
    }
    await authorize();
    const event = await transport.send(room, { ...content, 'm.mentions': {}, [SERVICE]: true });
    this.last.delete(room);
    while (this.last.size >= this.capacity) this.last.delete(this.last.keys().next().value!);
    this.last.set(room, { key: report.key, event, repeats: 0, last: this.now() });
  }
}
