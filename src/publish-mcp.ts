import { startToolMcp } from './tool-mcp.js';
import { publishInput } from './publish.js';

export type PublishAction = (input: unknown, signal: AbortSignal) => Promise<string>;
export type PublishConnection = { url: string; headers: { Authorization: string } };
export const PUBLISH_SERVER = 'riftjack_publish';
export const PUBLISH_TOOL = 'mcp__riftjack_publish__prepare_publish';
export const publicationInstructions = '\nFor Git publication, call the Riftjack prepare_publish MCP tool with repository, remote and either branch (current HEAD) or branches (1–20 objects with branch and full commit SHA in head). A branches package has one complete review and one approval, then one atomic push with a lease for every destination. It never falls back to partial publication. No checkout is needed for explicit SHAs. For a fork rebased onto upstream, add review_base: {remote: "upstream", branch: "main"}. This uses the advertised upstream branch for the diff and published-history classification, shows its URL and SHA, and rechecks it before pushing. Commit intended changes first. The tool registers a connector-owned operation and returns a publication_id with status preparing. The connector sends the complete HTML review, waits for explicit human approval, and only then pushes the reviewed commits. The operation survives completion of the model turn. Its saved result arrives in a separate background turn. Do not submit the operation again or mutate its repository while waiting; a receipt is not publication success. The human can inspect !status or use !cancel. Connector restart expires pending approvals and reports interruption without replaying push. Do not substitute a shell push or treat ordinary chat as approval. Respect an explicit human decline or cancellation; request renewed permission before another review. After a technical interruption or lost result, check the destination and whether the previous request is still active. If already published, report it without repeating. If not published and no request remains active, prepare a fresh review within the authorized task without waiting for another invitation. If the outcome or cancellation reason cannot be established, report the blocker and ask for clarification. Every new review requires fresh human approval; never reuse an expired confirmation.';

const tool = {
  name: 'prepare_publish',
  description: 'Register a publication operation, return its ID, and deliver a complete HTML review to the current Matrix conversation. After human approval, publish exactly the reviewed commits and deliver the saved result in a background turn. Rebased branches require explicit approval of history replacement, with outgoing and removed history shown and an exact remote-tip lease. A branches package publishes exact SHAs with one approval and one atomic push; unsupported atomic push fails without fallback. The operation outlives this call and model turn; it has its own deadline. A pending receipt is not publication success. Respect human declines and cancellations. After a technical interruption, verify the destination and that no previous request remains active before preparing a fresh review with fresh human approval. Do not repeat a completed push; clarify unresolved state before retrying.',
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
    cancelled: 'Publication tool call cancelled or interrupted. A registered operation may still be pending or completed: inspect !status and its background result before resubmitting. Closing this call does not cancel connector-owned publication; the human can use !cancel. An uncertain push must be checked at the destination. Expired approval is never reused.',
    failed: 'Publication failed. Check the destination before attempting another reviewed request.',
  });
}
