import { randomUUID } from 'node:crypto';
import { PublicError } from './errors.js';
import { confirmationDetails } from './confirmation-format.js';
import type { Interact } from './interactions.js';
import { startToolMcp, type ToolAction } from './tool-mcp.js';

export const CONFIRMATION_SERVER = 'riftjack_confirmation';
export const CONFIRMATION_TOOL = 'mcp__riftjack_confirmation__request_confirmation';
export const confirmationInstructions = '\nWhen explicit human consent for a concrete proposal is needed, use request_confirmation instead of asking for a typed yes. Do not ask again for work already authorized. State the exact scope and relevant consequences in question/details. Only status=approved is consent for that proposal; declined means human refusal, expired means no answer in time, and cancellation or delivery failure is not refusal. The tool only collects a decision: it executes nothing, grants no sandbox permissions, and does not replace command approvals or prepare_publish. The tool returns a request_id with status preparing. The connector owns the question independently of the model turn and delivers its saved decision in a background turn. Use action=status with id=request_id for the exact proposal and result, or omit id to list recent questions. A preparing receipt is not consent. Connector restart expires unanswered questions; never replay an expired approval.';

export function confirmationInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PublicError('Expected a confirmation request.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['question', 'details', 'timeout_seconds'].includes(key))) throw new PublicError('Unknown confirmation parameter.');
  if (typeof value.question !== 'string' || !value.question.trim() || value.question.length > 4000) throw new PublicError('question must contain 1–4000 characters.');
  if (value.details !== undefined && (typeof value.details !== 'string' || value.details.length > 12000)) throw new PublicError('details must be at most 12000 characters.');
  const timeout = value.timeout_seconds ?? 600;
  if (!Number.isSafeInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 3600) throw new PublicError('timeout_seconds must be an integer from 1 to 3600.');
  return { question: value.question, details: value.details as string | undefined, timeout_seconds: timeout as number };
}

export async function requestConfirmation(input: unknown, signal: AbortSignal, interact: Interact): Promise<string> {
  const request = confirmationInput(input);
  signal.throwIfAborted();
  const requestId = randomUUID();
  const deadline = new AbortController();
  const expired = new Error('Confirmation deadline elapsed.');
  const timer = setTimeout(() => deadline.abort(expired), request.timeout_seconds * 1000);
  const combined = AbortSignal.any([signal, deadline.signal]);
  const result = (status: string) => JSON.stringify({ request_id: requestId, status, question: request.question,
    ...(request.details !== undefined && { details: request.details }) });
  try {
    const approved = { status: 'approved' }, declined = { status: 'declined' };
    const decision = await interact({ ...confirmationDetails([
      { label: 'Proposal', value: request.question },
      ...(request.details ? [{ label: 'Details', value: request.details }] : []),
      { label: 'Response window', value: `${request.timeout_seconds} seconds. Ending the model turn does not cancel this question.` },
      { value: 'This records your decision only. It does not execute commands or replace publication and command approvals.' },
    ]), approve: approved, deny: declined }, combined);
    // Interactions removes unanswered requests on expiry. A decision already
    // accepted before expiry remains valid even if reaction seeding finishes late.
    signal.throwIfAborted();
    // Do not interpret arbitrary interaction results as consent.
    if (decision === approved) return result('approved');
    if (decision === declined) return result('declined');
    throw new PublicError('Unexpected confirmation response. No consent was recorded.');
  } catch (error) {
    signal.throwIfAborted();
    if (combined.reason === expired) return result('expired');
    throw error;
  } finally { clearTimeout(timer); }
}

export function startConfirmationMcp(action: ToolAction, signal: AbortSignal) {
  return startToolMcp({ name: 'request_confirmation',
    description: 'Ask the human to approve or decline a concrete proposal using Matrix reactions. Returns a request_id immediately; the saved decision arrives in a background turn. action=status retrieves the full proposal and result. Executes nothing and does not replace sandbox or publication approvals. Cancellation and delivery failure are errors, never human refusals. Pending questions survive the model turn but expire on connector restart.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['status'], description: 'Retrieve a saved decision by id, or list recent requests when id is omitted.' },
      id: { type: 'string' },
      question: { type: 'string', minLength: 1, maxLength: 4000, description: 'Concrete proposal to approve.' },
      details: { type: 'string', maxLength: 12000, description: 'Exact scope and consequences, shown as literal text.' },
      timeout_seconds: { type: 'integer', minimum: 1, maximum: 3600, default: 600 },
    } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, action, signal, {
    server: CONFIRMATION_SERVER,
    cancelled: 'Confirmation tool call interrupted. An admitted question may still be pending. Inspect action=status before asking again. This is not a human refusal or approval. This response itself establishes no consent.',
    failed: 'Confirmation could not be completed. This is not a human refusal or approval. No consent is established by this result.',
  }, { maxQueued: 9, maxRequestBytes: 128 * 1024 });
}
