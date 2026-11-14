import { getRequestFn, setRequestFn } from '@vector-im/matrix-bot-sdk';
import { Agent, Dispatcher1Wrapper, type Dispatcher } from 'undici';
import { format } from 'node:url';
import { diagnosticContext, diagnosticOperation, matrixEndpoint, type DiagnosticContext } from './diagnostics.js';

export type MatrixHttpVersion = 'auto' | '1.1';

// SDK requests and explicit Matrix fetches share this policy, never the process's
// global dispatcher. Keep long polls out of the pool used by messages and media.
export function installMatrixTransport(version: MatrixHttpVersion, origins: string[],
  agent: (options: Agent.Options) => Dispatcher = options => new Agent(options),
  report?: (error: unknown, details: DiagnosticContext) => void) {
  const originalRequest = getRequestFn();
  const originalFetch = globalThis.fetch;
  if (version === 'auto' && !report) return { fetch: originalFetch, destroy: async () => {} };

  const allowed = new Set(origins.map(origin => new URL(origin).origin));
  const homeserver = new URL(origins[0]).origin;
  const options = { allowH2: false, keepAliveTimeout: 10_000, keepAliveMaxTimeout: 30_000 };
  const regular = version === '1.1' ? agent({ ...options, connections: 16 }) : undefined;
  // No fixed cap: every bot can hold a /sync concurrently.
  const sync = version === '1.1' ? agent(options) : undefined;
  // Node's bundled fetch may still use dispatcher API v1, while SDK undici 8
  // uses v2. This adapter handles both without installing any global shim.
  const fetchRegular = regular && new Dispatcher1Wrapper(regular);
  const fetchSync = sync && new Dispatcher1Wrapper(sync);
  const dispatcher = (url: URL) => allowed.has(url.origin)
    ? (/\/_matrix\/client\/[^/]+\/sync$/.test(url.pathname) ? sync : regular) : undefined;
  const observe = async <T extends { status?: number; statusCode?: number }>(url: URL, method: string, run: () => Promise<T>) => {
    if (!report || !allowed.has(url.origin)) return run();
    const details: DiagnosticContext = { operation: 'matrix.http', endpoint: matrixEndpoint(url.pathname), method,
      transport: version, destination: url.origin === homeserver ? 'homeserver' : 'admin' };
    // The SDK request owner reports after reading/decoding the body. Retain
    // transport context, but do not emit a second record for that same attempt.
    const requestOwnsError = diagnosticContext()?.reportsMatrixErrors;
    const emit = (error: unknown) => {
      if (requestOwnsError) return;
      try { report(error, details); } catch { /* Observation must not affect transport. */ }
    };
    try {
      return await diagnosticOperation(details, async () => {
        const response = await run();
        const status = response.statusCode ?? response.status;
        if (status && status >= 400) emit({ status });
        return response;
      });
    } catch (error) { emit(error); throw error; }
  };
  const request: typeof originalRequest = (url, init) => {
    const parsed = new URL(typeof url === 'string' || url instanceof URL ? url : format(url));
    const selected = dispatcher(parsed);
    return observe(parsed, init?.method ?? 'GET', () => originalRequest(url, selected ? { ...init, dispatcher: selected } : init));
  };
  const fetcher: typeof fetch = (input, init) => {
    const selected = dispatcher(new URL(input instanceof Request ? input.url : input));
    // Node fetch accepts an undici dispatcher; retain its native Request/Response
    // types, abort signals, streaming bodies and redirect behavior.
    const options: (RequestInit & { dispatcher?: Dispatcher }) | undefined = selected
      ? { ...init, dispatcher: selected === sync ? fetchSync : fetchRegular } : init;
    return observe(new URL(input instanceof Request ? input.url : input), init?.method ?? (input instanceof Request ? input.method : 'GET'),
      () => originalFetch(input, options));
  };
  setRequestFn(request);
  return {
    fetch: fetcher,
    async destroy() {
      if (getRequestFn() === request) setRequestFn(originalRequest);
      await Promise.all([regular?.destroy(), sync?.destroy()]);
    },
  };
}
