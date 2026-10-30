import { ApprovalJobs, type ApprovalJobOptions } from './approval-jobs.js';
import { publishInput, type PublicationInput } from './publish.js';

type Options = Pick<ApprovalJobOptions, 'timeoutMs' | 'valid' | 'authorize' | 'send' | 'notify' | 'report'> & {
  execute: (input: PublicationInput, ...args: Parameters<ApprovalJobOptions['execute']> extends [unknown, ...infer Rest] ? Rest : never) => Promise<string>;
};
export class PublicationJobs extends ApprovalJobs {
  constructor(path: string, options: Options) {
    super(path, { ...options, kind: 'publication', label: 'Publication', idField: 'publication_id', validate: publishInput,
      authorize: target => options.authorize(target), notify: (...args) => options.notify(...args),
      execute: (input, ...args) => options.execute(publishInput(input), ...args),
      outcome: result => result.startsWith('Published ') ? 'succeeded' : 'declined',
      receipt: 'Publication is owned by the connector and survives this model turn. Wait for its background result; do not submit it again or change the reviewed repository while approval is pending. The human can use !status and !cancel in this conversation.',
      guidance: 'This is not new approval. Do not repeat publication. Continue the original task after success; inspect the destination if uncertain. A decline or explicit cancellation requires renewed human permission before another publication.',
    });
  }
}
