import { getRequestFn, setRequestFn } from '@vector-im/matrix-bot-sdk';
import { Agent, Dispatcher1Wrapper, type Dispatcher } from 'undici';
import { format } from 'node:url';

export type MatrixHttpVersion = 'auto' | '1.1';

// SDK requests and explicit Matrix fetches share this policy, never the process's
// global dispatcher. Keep long polls out of the pool used by messages and media.
export function installMatrixTransport(version: MatrixHttpVersion, origins: string[],
  agent: (options: Agent.Options) => Dispatcher = options => new Agent(options)) {
  const originalRequest = getRequestFn();
  const originalFetch = globalThis.fetch;
  if (version === 'auto') return { fetch: originalFetch, destroy: async () => {} };

  const allowed = new Set(origins.map(origin => new URL(origin).origin));
  const options = { allowH2: false, keepAliveTimeout: 10_000, keepAliveMaxTimeout: 30_000 };
  const regular = agent({ ...options, connections: 16 });
  // No fixed cap: every bot can hold a /sync concurrently.
  const sync = agent(options);
  // Node's bundled fetch may still use dispatcher API v1, while SDK undici 8
  // uses v2. This adapter handles both without installing any global shim.
  const fetchRegular = new Dispatcher1Wrapper(regular);
  const fetchSync = new Dispatcher1Wrapper(sync);
  const dispatcher = (url: URL) => allowed.has(url.origin)
    ? (/\/_matrix\/client\/[^/]+\/sync$/.test(url.pathname) ? sync : regular) : undefined;
  const request: typeof originalRequest = (url, init) => {
    const selected = dispatcher(new URL(typeof url === 'string' || url instanceof URL ? url : format(url)));
    return originalRequest(url, selected ? { ...init, dispatcher: selected } : init);
  };
  const fetcher: typeof fetch = (input, init) => {
    const selected = dispatcher(new URL(input instanceof Request ? input.url : input));
    // Node fetch accepts an undici dispatcher; retain its native Request/Response
    // types, abort signals, streaming bodies and redirect behavior.
    const options: RequestInit & { dispatcher?: Dispatcher } = selected
      ? { ...init, dispatcher: selected === sync ? fetchSync : fetchRegular } : { ...init };
    return originalFetch(input, options);
  };
  setRequestFn(request);
  return {
    fetch: fetcher,
    async destroy() {
      if (getRequestFn() === request) setRequestFn(originalRequest);
      await Promise.all([regular.destroy(), sync.destroy()]);
    },
  };
}
