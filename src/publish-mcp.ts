import { startToolMcp } from './tool-mcp.js';
import { publishInput } from './publish.js';

export type PublishAction = (input: unknown, signal: AbortSignal) => Promise<string>;
export type PublishConnection = { url: string; headers: { Authorization: string } };
export const PUBLISH_SERVER = 'riftjack_publish';
export const PUBLISH_TOOL = 'mcp__riftjack_publish__prepare_publish';
export const publicationInstructions = '\nFor Git publication, call the Riftjack prepare_publish MCP tool with repository, remote and either branch (current HEAD) or branches (1–20 objects with branch and full commit SHA in head). A branches package has one complete review and one approval, then one atomic push with a lease for every destination. It never falls back to partial publication. No checkout is needed for explicit SHAs. For a fork rebased onto upstream, add review_base: {remote: "upstream", branch: "main"}. This uses the advertised upstream branch for the diff and published-history classification, shows its URL and SHA, and rechecks it before pushing. Commit intended changes first. The tool sends a complete HTML review to this Matrix conversation, waits for explicit human approval, and only then pushes the reviewed commits. Do not substitute a shell push or treat ordinary chat as approval. Respect an explicit human decline or cancellation; request renewed permission before another review. After a technical interruption or lost result, check the destination and whether the previous request is still active. If already published, report it without repeating. If not published and no request remains active, prepare a fresh review within the authorized task without waiting for another invitation. If the outcome or cancellation reason cannot be established, report the blocker and ask for clarification. Every new review requires fresh human approval; never reuse an expired confirmation.';

const tool = {
  name: 'prepare_publish',
  description: 'Prepare and deliver an HTML review of committed Git changes to the current Matrix conversation, wait for human approval, then publish exactly those commits. Rebased branches require explicit approval of history replacement, with outgoing and removed history shown and an exact remote-tip lease. A branches package publishes exact SHAs with one approval and one atomic push; unsupported atomic push fails without fallback. This call may wait for up to the task timeout. Respect human declines and cancellations. After a technical interruption, verify the destination and that no previous request remains active before preparing a fresh review with fresh human approval. Do not repeat a completed push; clarify unresolved state before retrying.',
  inputSchema: { type: 'object', additionalProperties: false,
    properties: { repository: { type: 'string', description: 'Git repository path within the bot workspace.' }, remote: { type: 'string', description: 'Named Git remote, for example origin.' }, branch: { type: 'string', description: 'Destination branch for current HEAD, for example main.' },
      review_base: { type: 'object', additionalProperties: false, description: 'Optional published upstream base for rebases onto a fork with a stale default branch. Its remote URL and branch SHA are shown and rechecked before publication.', properties: { remote: { type: 'string' }, branch: { type: 'string' } }, required: ['remote', 'branch'] },
      branches: { type: 'array', minItems: 1, maxItems: 20, description: 'Atomic package of exact destination branch/commit pairs. Do not also supply branch.',
        items: { type: 'object', additionalProperties: false, properties: {
          branch: { type: 'string' }, head: { type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' },
        }, required: ['branch', 'head'] } } },
    required: ['repository', 'remote'], oneOf: [{ required: ['branch'] }, { required: ['branches'] }] },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};
export function startPublishMcp(publish: PublishAction, signal: AbortSignal) {
  return startToolMcp(tool, (input, callSignal) => publish(publishInput(input), callSignal), signal, {
    server: 'riftjack-publish',
    cancelled: 'Publication cancelled or interrupted. A push already in progress may have completed. Check the destination and previous request before retrying. Respect human cancellation; after a technical interruption, an unpublished change may receive a fresh review once no request remains active. Fresh human approval is required.',
    failed: 'Publication failed. Check the destination before attempting another reviewed request.',
  });
}
