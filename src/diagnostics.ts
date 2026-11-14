import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { errorMessage, PublicError, safeErrorSummary } from './errors.js';

// Call sites supply operation names, never exception text, URLs or request data.
export type DiagnosticContext = {
  operation: string;
  // Internal ownership of HTTP errors; deliberately absent from emitted records.
  reportsMatrixErrors?: boolean;
  trace?: string;
  span?: string;
  parentSpan?: string;
  operations?: string[];
  bot?: string;
  task?: string;
  attempt?: number;
  taskAttempt?: number;
  endpoint?: string;
  method?: string;
  transport?: 'auto' | '1.1';
  destination?: 'homeserver' | 'admin' | 'other';
};

const context = new AsyncLocalStorage<DiagnosticContext>();
const failures = new WeakMap<object, DiagnosticContext & { elapsedMs: number; observedAt: number }>();
const token = (value: string | undefined) => value === undefined ? undefined
  : createHash('sha256').update(value).digest('hex').slice(0, 16);
const label = (value: string | undefined) => value && /^[a-z][a-z0-9_.-]{0,79}$/.test(value) ? value : undefined;
const sourceRoot = fileURLToPath(new URL('.', import.meta.url));
// Only source filenames shipped beside this module can appear in a diagnostic.
// Exception messages, function labels and absolute paths are never stack fields.
const sourceFiles = new Set<string>();
try { for (const file of readdirSync(sourceRoot)) if (/\.(?:[cm]?js|ts)$/.test(file)) sourceFiles.add(file); } catch { /* Stack locations unavailable. */ }

function locations(error: unknown) {
  const frames: { file: string; line: number; column: number }[] = [];
  const seen = new Set<unknown>();
  const queue = [error];
  for (let depth = 0; depth < queue.length && depth < 20 && frames.length < 8; depth++) {
    error = queue[depth];
    if (!error || typeof error !== 'object' || seen.has(error)) continue;
    seen.add(error);
    try {
      const stack = (error as { stack?: unknown }).stack;
      if (typeof stack === 'string') for (const line of stack.slice(0, 16_000).split('\n').slice(1, 25)) {
        const index = line.lastIndexOf(sourceRoot);
        if (index < 0) continue;
        const match = /^([^/\\:]+):(\d{1,7}):(\d{1,7})\)?$/.exec(line.slice(index + sourceRoot.length));
        if (match && sourceFiles.has(match[1]) && frames.length < 8) {
          frames.push({ file: match[1], line: Number(match[2]), column: Number(match[3]) });
        }
      }
      if (queue.length < 20) queue.push((error as { cause?: unknown }).cause);
      if (error instanceof AggregateError && Array.isArray(error.errors)) queue.push(...error.errors.slice(0, Math.max(0, 20 - queue.length)));
    } catch { /* Other causes can still provide locations. */ }
  }
  return frames;
}

export function diagnosticContext(): DiagnosticContext | undefined { return context.getStore(); }

// Preserve the original exception identity, cancellation and caller retry policy.
// Weak references retain context after an async boundary without modifying SDK errors.
export async function diagnosticOperation<T>(details: DiagnosticContext, run: () => Promise<T>): Promise<T> {
  const parent = context.getStore();
  const current = { ...parent, ...details, trace: parent?.trace ?? randomUUID(), span: randomUUID(),
    parentSpan: parent?.span, operations: [...(parent?.operations ?? []), details.operation].slice(-8) };
  const started = performance.now();
  return context.run(current, async () => {
    try { return await run(); }
    catch (error) {
      if (error && typeof error === 'object' && (failures.get(error)?.observedAt ?? -Infinity) < started) {
        failures.set(error, { ...current, elapsedMs: Math.round(performance.now() - started), observedAt: performance.now() });
      }
      throw error;
    }
  });
}

export function diagnosticRecord(error: unknown, details: DiagnosticContext) {
  let failed: (DiagnosticContext & { elapsedMs: number; observedAt: number }) | undefined;
  let cause = error;
  const seen = new Set<unknown>();
  for (let i = 0; i < 20 && cause && typeof cause === 'object' && !seen.has(cause); i++) {
    seen.add(cause);
    failed = failures.get(cause) ?? failed;
    try { cause = (cause as { cause?: unknown }).cause; } catch { break; }
  }
  const current = { ...context.getStore(), ...failed,
    ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) };
  let summary: string;
  try { summary = safeErrorSummary(error); } catch { summary = 'Error (diagnostic fields unavailable)'; }
  let publicMessage: string | undefined;
  try { if (error instanceof PublicError) publicMessage = errorMessage(error); } catch { /* Preserve the other fields. */ }
  return {
    time: new Date().toISOString(), event: 'connector-error',
    operation: label(details.operation) ?? 'unknown',
    failedOperation: label(failed?.operation),
    trace: current.trace && /^[a-f0-9-]{36}$/.test(current.trace) ? current.trace : undefined,
    span: current.span && /^[a-f0-9-]{36}$/.test(current.span) ? current.span : undefined,
    parentSpan: current.parentSpan && /^[a-f0-9-]{36}$/.test(current.parentSpan) ? current.parentSpan : undefined,
    operations: current.operations?.slice(-8).map(label).filter(Boolean),
    bot: token(current.bot), task: token(current.task),
    attempt: Number.isSafeInteger(current.attempt) && current.attempt! >= 0 ? current.attempt : undefined,
    taskAttempt: Number.isSafeInteger(current.taskAttempt) && current.taskAttempt! >= 0 ? current.taskAttempt : undefined,
    elapsedMs: failed?.elapsedMs,
    endpoint: label(current.endpoint),
    method: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'].includes(current.method ?? '') ? current.method : undefined,
    transport: ['auto', '1.1'].includes(current.transport ?? '') ? current.transport : undefined,
    destination: ['homeserver', 'admin', 'other'].includes(current.destination ?? '') ? current.destination : undefined,
    error: summary,
    publicMessage,
    locations: locations(error),
  };
}

export function reportDiagnostic(error: unknown, details: DiagnosticContext): void {
  // Logging must never replace the original failure or create an unhandled rejection.
  try { console.error(JSON.stringify(diagnosticRecord(error, details))); } catch { /* Host log unavailable. */ }
}

// Deliberately return categories, not redacted URLs: room IDs, media IDs,
// transaction IDs, state keys and query strings must never reach host logs.
export function matrixEndpoint(endpoint: string): string {
  const path = endpoint.split('?')[0];
  if (/\/_synapse\/admin\//.test(path)) return 'admin';
  if (/\/_matrix\/(?:media|client\/[^/]+\/media)\//.test(path)) return 'media';
  if (/\/_matrix\/client\/[^/]+\/sync$/.test(path)) return 'sync';
  if (/\/rooms\/[^/]+\/(?:send|redact)\//.test(path)) return 'room-send';
  if (/\/rooms\/[^/]+\/(?:state|members|joined_members)(?:\/|$)/.test(path)) return 'room-state';
  if (/\/rooms\/[^/]+\/typing\//.test(path)) return 'typing';
  if (/\/rooms\/[^/]+\/(?:messages|event|context)(?:\/|$)/.test(path)) return 'room-history';
  if (/\/(?:keys|room_keys|sendToDevice)(?:\/|$)/.test(path)) return 'crypto';
  if (/\/(?:account|account_data|profile|devices|user)(?:\/|$)/.test(path)) return 'account';
  if (/\/(?:join|joined_rooms|createRoom)(?:\/|$)/.test(path)) return 'room-membership';
  return 'other';
}

export function transportConfiguration(version: 'auto' | '1.1', homeserver: string, admin: string,
  tunnel: boolean, env: NodeJS.ProcessEnv) {
  return { event: 'matrix-transport-config', policy: version, adminTunnelConfigured: tunnel,
    homeserverAndAdminSameOrigin: new URL(homeserver).origin === new URL(admin).origin,
    adminLoopback: ['127.0.0.1', '[::1]', 'localhost'].includes(new URL(admin).hostname),
    proxyEnvironmentPresent: ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some(key => !!env[key]),
    nodeEnvProxyEnabled: env.NODE_USE_ENV_PROXY === '1',
    routeObservation: 'configuration-only',
  };
}
