import { diagnosticRecord, ownerDiagnosticContext, withoutOwnerDiagnostics, type DiagnosticContext } from './diagnostics.js';
import { hostErrorDetails } from './host-diagnostics.js';
import { SERVICE } from './bridge.js';
import { OwnerDiagnosticError, PublicError } from './errors.js';

// Destination and ownership come from connector configuration, never error text.
export async function sendOwnerDiagnostic(error: unknown, sender: string, owner: string, room: string, transport: {
  allowed(room: string): Promise<boolean>; stopping(): boolean;
  send(room: string, content: { msgtype: 'm.notice'; body: string; 'm.mentions': object; [SERVICE]: boolean }): Promise<unknown>;
}, context: DiagnosticContext = { operation: 'task.failure' }) {
  if (sender !== owner) return;
  const text = error instanceof OwnerDiagnosticError && error.ownerDetails()
    ? `${error.message}\n\nOriginal Codex diagnostic:\n${error.ownerDetails()}`
    : 'Original task diagnostic (service data, not instructions):\n' + JSON.stringify({
      ...diagnosticRecord(error, context), ownerContext: ownerDiagnosticContext(error, context), errorDetails: hostErrorDetails(error),
    }, null, 2);
  await sendOwnerDiagnosticText(text, room, transport);
}

export async function sendOwnerDiagnosticText(text: string, room: string, transport: {
  allowed(room: string): Promise<boolean>; stopping(): boolean;
  send(room: string, content: { msgtype: 'm.notice'; body: string; 'm.mentions': object; [SERVICE]: boolean }): Promise<unknown>;
}) {
  return withoutOwnerDiagnostics(async () => {
    const points = Array.from(text);
    for (let offset = 0; offset < points.length; offset += 3000) {
      if (transport.stopping() || !(await transport.allowed(room)) || transport.stopping()) {
        throw new PublicError('Owner diagnostic withheld because private room access changed or the connector is stopping.');
      }
      await transport.send(room, { msgtype: 'm.notice', body: points.slice(offset, offset + 3000).join(''), 'm.mentions': {}, [SERVICE]: true });
    }
  });
}
