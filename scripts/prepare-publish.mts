// Structured, read-only publication review API for local tools and external workers.
// This command does not approve or push; Matrix !publish owns that workflow.
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { preparePublish, publishInput } from '../src/publish.js';
import { PublicError } from '../src/errors.js';

try {
  const { values } = parseArgs({ options: { workspace: { type: 'string' }, request: { type: 'string' }, output: { type: 'string' } }, strict: true });
  if (!values.workspace || !values.request || !values.output) throw new PublicError('Supply --workspace DIRECTORY --request JSON --output FILE.html.');
  let input: unknown;
  try { input = JSON.parse(values.request); } catch { throw new PublicError('--request must contain a JSON object.'); }
  const review = await preparePublish(publishInput(input), values.workspace, AbortSignal.timeout(10 * 60_000));
  const output = resolve(values.output);
  await writeFile(output, review.html, { flag: 'wx', mode: 0o600 });
  const branchMetadata = (branch: import('../src/publish.js').PublishReview) => ({
    head: branch.head, base: branch.base, reviewBase: branch.reviewBase, baseReference: branch.baseReference, upstreamReference: branch.upstreamReference,
    branch: branch.branch, historyReplacement: branch.historyReplacement,
    removedCommits: branch.removedHistory.length, commits: branch.commits.length,
  });
  console.log(JSON.stringify({ output, remote: review.remote, sha256: review.sha256, published: false,
    ...('branches' in review ? { atomic: true, branches: review.branches.map(branchMetadata) } : branchMetadata(review)) }));
} catch (error) {
  console.error(error instanceof PublicError ? error.message : 'Could not create the review. Check paths, output-file availability and Git authentication.');
  process.exitCode = 1;
}
