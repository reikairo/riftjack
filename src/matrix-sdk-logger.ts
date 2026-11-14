import type { ILogger } from '@vector-im/matrix-bot-sdk';
import { diagnosticContext, reportDiagnostic } from './diagnostics.js';
import { safeErrorSummary } from './errors.js';

function sdkOperation(module: string, warning = false): string {
  const component = module === 'MatrixHttpClient' ? 'http' : module === 'MatrixClientLite' ? 'client' : 'other';
  return `matrix.sdk.${component}${warning ? '-warning' : ''}`;
}

export function matrixSdkLogger(report = reportDiagnostic): ILogger {
  return {
    info() {}, debug() {}, trace() {},
    warn(module, ...args) { report(new AggregateError(args), { operation: sdkOperation(module, true) }); },
    // SDK arguments can hold tokens and request bodies; only allow-listed codes are printed.
    error(module, ...args) {
      if (module === 'MatrixHttpClient' && diagnosticContext()?.reportsMatrixErrors) return;
      const details = args.map(error => { try { return safeErrorSummary(error); } catch { return 'Error (no safe diagnostic details available)'; } })
        .filter(summary => !summary.startsWith('Error (no safe'));
      // The HTTP layer logs every non-2xx response before callers handle it. M_NOT_FOUND is an
      // expected answer (e.g. a bot has no m.direct account data at startup) and is handled there.
      if (module === 'MatrixHttpClient' && details.length === 1 && details[0] === 'M_NOT_FOUND') return;
      report(new AggregateError(args), { operation: sdkOperation(module) });
    },
  };
}
