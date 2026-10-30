import { ApprovalJobs, type ApprovalJobOptions } from './approval-jobs.js';
import { requestConfirmation, confirmationInput } from './confirmation-mcp.js';
import type { DetachedRuns } from './detached-runs.js';
import { PublicError } from './errors.js';
type Common = Pick<ApprovalJobOptions, 'timeoutMs' | 'valid' | 'authorize' | 'send' | 'notify' | 'report'>;

export function createConfirmationJobs(path: string, approvalOptions: Common) {
  return new ApprovalJobs(path, {
      ...approvalOptions, kind: 'confirmation', label: 'Confirmation', idField: 'request_id', validate: confirmationInput,
      timeoutFor: input => confirmationInput(input).timeout_seconds * 1000,
      execute: async (input, signal, interact) => {
        const { request_id: _localId, ...result } = JSON.parse(await requestConfirmation(input, signal, interact));
        return JSON.stringify(result);
      },
      outcome: result => JSON.parse(result).status,
      receipt: 'The connector is waiting for the human. This is not consent. The decision will arrive in a background turn; use action=status with id=request_id for the full saved proposal and result. Do not repeat the question.',
      guidance: 'This saved decision concerns only the exact recorded proposal. Read action=status with this request_id if truncated. Only approved is consent; it never replaces sandbox or publication approval. Do not repeat an unanswered or declined proposal automatically.',
    });
}
export function createRunApprovalJobs(path: string, approvalOptions: Common, detached: DetachedRuns) {
  return new ApprovalJobs(path, {
      ...approvalOptions, kind: 'detached', label: 'Run approval', idField: 'operation_id',
      validate: input => {
        if (!input || typeof input !== 'object' || !['start', 'close'].includes((input as {action: string}).action) || JSON.stringify(input).length > 32_000) throw new PublicError('Expected a bounded start or close request.');
        return input;
      },
      execute: (input, signal, interact, authorize, target) => detached.action(input, target, signal, interact, authorize),
      outcome: result => JSON.parse(result).closed ? 'closed' : JSON.parse(result).status,
      receipt: 'The connector owns this approval request. Wait for its background result. Use action=approval_status with id=operation_id to retrieve it. No command has been launched.',
      guidance: 'Inspect action=approval_status for the full saved result. A prepared launch must be executed once through the ordinary command tool and its sandbox approval, before launch_by. Check run status before any uncertain launch; do not automatically repeat a launch. A decline is not approval.',
    });
}
