import { safeErrorSummary, TypingUpdateTimeout } from './errors.js';

export type TypingMeasurement = {
  event: 'typing-update'; typing: boolean; status: 'success' | 'skipped' | 'failed' | 'timeout';
  phase: 'authorize' | 'send'; elapsedMs: number; sinceLastSuccessMs?: number; diagnostic?: string;
};
const REQUEST_TIMEOUT_MS = 8_000;

// A late room authorization read must never start a late send.
function authorizeWithin(check: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    check.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// Matrix typing is room-scoped, expires on the server and never carries task text.
export function taskTyping(send: (typing: boolean, timeout: number, signal: AbortSignal) => Promise<unknown>,
  allowed: () => Promise<boolean>, report: (error: unknown) => void, signal: AbortSignal,
  measure?: (measurement: TypingMeasurement) => void) {
  let closed = false, pending: Promise<void> | undefined, closing: Promise<void> | undefined;
  let deliveries = 0, resumeTimer: ReturnType<typeof setTimeout> | undefined;
  const active = () => !closed && !signal.aborted;
  let lastSuccess: number | undefined;
  let previousTimedOut = false;
  const update = async (typing: boolean) => {
    const started = performance.now(), deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new TypingUpdateTimeout(previousTimedOut)), REQUEST_TIMEOUT_MS);
    timeout.unref();
    let phase: TypingMeasurement['phase'] = 'authorize';
    const measurement = (status: TypingMeasurement['status'], error?: unknown) => {
      try { measure?.({ event: 'typing-update', typing, status, phase,
        elapsedMs: Math.round(performance.now() - started),
        ...(lastSuccess !== undefined && { sinceLastSuccessMs: Math.round(performance.now() - lastSuccess) }),
        ...(error !== undefined && { diagnostic: safeErrorSummary(error) }) }); }
      catch { /* Logging must not affect task or indicator delivery. */ }
    };
    try {
      const permitted = await authorizeWithin(allowed(), deadline.signal);
      deadline.signal.throwIfAborted();
      if (!permitted || (typing && (!active() || deliveries))) { measurement('skipped'); return; }
      phase = 'send';
      // Abort the actual HTTP request; do not detach it with Promise.race.
      await send(typing, 30_000, deadline.signal);
      deadline.signal.throwIfAborted();
      previousTimedOut = false;
      measurement('success'); lastSuccess = performance.now();
    } catch (error) {
      previousTimedOut = deadline.signal.aborted && error === deadline.signal.reason;
      measurement(previousTimedOut ? 'timeout' : 'failed', error);
      report(error);
    } finally { clearTimeout(timeout); }
  };
  const enqueue = (typing: boolean) => {
    const next = (pending ? pending.then(() => update(typing)) : update(typing)).finally(() => {
      if (pending === next) pending = undefined;
    });
    pending = next;
    return next;
  };
  const refresh = () => {
    if (active() && !deliveries && !resumeTimer && !pending) void enqueue(true);
  };
  const cancelResume = () => { clearTimeout(resumeTimer); resumeTimer = undefined; };
  const message = async <T>(deliver: () => Promise<T>): Promise<T> => {
    if (!active()) return deliver();
    deliveries++;
    cancelResume();
    try {
      // Clear before sending: clients can hide typing on receipt, while Synapse
      // suppresses repeated true updates. Serialize after any in-flight renewal.
      await enqueue(false);
      signal.throwIfAborted();
      return await deliver();
    } finally {
      deliveries--;
      if (!deliveries && active()) {
        // Separate the new typing event from message processing in the client.
        // Other deliveries and task completion cancel this delayed restore.
        resumeTimer = setTimeout(() => { resumeTimer = undefined; refresh(); }, 250);
        resumeTimer.unref();
      }
    }
  };
  const timer = setInterval(refresh, 10_000);
  timer.unref();
  const close = () => {
    if (closing) return closing;
    closed = true;
    clearInterval(timer);
    cancelResume();
    signal.removeEventListener('abort', onAbort);
    closing = enqueue(false);
    return closing;
  };
  const onAbort = () => { void close(); };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) void close();
  else refresh();
  return { close, message };
}
