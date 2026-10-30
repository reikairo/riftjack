import { PublicError } from './accounts.js';
import type { Interaction } from './interactions.js';
import type { ServerRequest } from './app-server.js';
import { confirmationDetails } from './confirmation-format.js';
import { approvalIntent } from './approval-intent.js';

const json = (value: unknown) => JSON.stringify(value, null, 2);
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function objectAnswer(text: string): Record<string, any> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new PublicError('Answer must be a JSON object.'); }
  if (!record(value)) throw new PublicError('Answer must be a JSON object.');
  return value;
}

export function deniedRequest(method: string): object | undefined {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' };
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  if (method === 'mcpServer/elicitation/request') return { action: 'cancel', content: null, _meta: null };
  return undefined;
}

export function codexInteraction(request: ServerRequest, item?: Record<string, any>, allowPersistentRules = false): Interaction | undefined {
  const p = request.params;
  const deny = deniedRequest(request.method);
  if (!deny) return undefined;
  const reason = typeof p.reason === 'string' ? [{ label: 'Reason', value: p.reason, spaced: true }] : [];
  switch (request.method) {
    case 'item/commandExecution/requestApproval': {
      const intent = approvalIntent(p.reason);
      const command = p.command || item?.command;
      const canApprove = typeof command === 'string' && command.trim().length > 0 &&
        (p.availableDecisions == null || (Array.isArray(p.availableDecisions) && p.availableDecisions.includes('accept')));
      // Only offer the server's exact proposed prefix, never derive one from
      // shell text or accept an edited prefix in the human's answer.
      const proposed = p.proposedExecpolicyAmendment;
      const amendment: string[] | undefined = allowPersistentRules && typeof command === 'string' && command.trim() &&
        (!p.kind || p.kind === 'command') && !p.networkApprovalContext &&
        Array.isArray(proposed) && proposed.length && proposed.every(arg => typeof arg === 'string' && arg.length && !arg.includes('\0'))
        ? [...proposed] : undefined;
      const canRemember = amendment && intent.prefix && JSON.stringify(intent.prefix) === JSON.stringify(amendment) &&
        (p.availableDecisions == null || (Array.isArray(p.availableDecisions) &&
        p.availableDecisions.some(decision => record(decision) &&
          JSON.stringify(decision.acceptWithExecpolicyAmendment?.execpolicy_amendment) === JSON.stringify(amendment))));
      return { ...confirmationDetails([
        { value: `Codex requests permission for a command${p.kind && p.kind !== 'command' ? ` (${p.kind})` : ''}.` },
        ...(intent.reason ? [{ label: 'Reason', value: intent.reason, spaced: true }] : []),
        { label: 'Command', value: String(command || '[not provided]'), code: 'command' },
        { label: 'Working directory', value: String(p.cwd || item?.cwd || '[not provided]'), code: true },
        ...(p.networkApprovalContext ? [{ label: 'Network', value: json(p.networkApprovalContext), code: true }] : []),
        ...(p.additionalPermissions ? [{ label: 'Additional permissions', value: json(p.additionalPermissions), code: true }] : []),
        ...(canRemember ? [
          { label: 'Proposed persistent command prefix (exact argument list)', value: json(amendment), code: true },
          { value: 'Approve / ✅ allows this request only. Approve and remember also saves this prefix in Codex rules so future matching commands can run outside the sandbox without asking. The prefix is not restricted to this working directory and may affect other sessions and bots sharing the same Codex configuration.' },
        ] : [{ value: 'This request only; no permanent rule.' }]),
      ]),
      approve: canApprove ? { decision: 'accept' } : undefined, deny,
      ...(canRemember && { answerLabel: '🔖 Approve and remember', answerHint: 'remember',
        answerReaction: { key: '🔖', answer: 'remember' }, answer: (text: string) => {
        if (text !== 'remember') throw new PublicError('Use the listed answer "remember" to approve and save exactly the displayed prefix, or approve once / decline.');
        return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: [...amendment] } } };
      } }) };
    }
    case 'item/fileChange/requestApproval':
      return { ...confirmationDetails([
        { value: 'Codex requests permission to change files.' }, ...reason,
        { label: 'Changes', value: item?.changes ? json(item.changes) : '[diff unavailable; approval disabled]', code: true },
        ...(p.grantRoot ? [{ label: 'Requested write root', value: String(p.grantRoot), code: true }] : []),
      ]),
      approve: Array.isArray(item?.changes) && item.changes.length ? { decision: 'accept' } : undefined, deny };
    case 'item/permissions/requestApproval': {
      if (!record(p.permissions)) return undefined;
      const permissions = Object.fromEntries(['network', 'fileSystem'].filter(key => p.permissions[key] != null).map(key => [key, p.permissions[key]]));
      return { ...confirmationDetails([
        { value: 'Codex requests additional permissions for this turn.' }, ...reason,
        { label: 'Working directory', value: String(p.cwd), code: true },
        { label: 'Permissions', value: json(permissions), code: true },
      ]),
        approve: { permissions, scope: 'turn' }, deny };
    }
    case 'item/tool/requestUserInput': {
      const questions = p.questions;
      if (!Array.isArray(questions) || !questions.length || questions.some(q => !q || typeof q.id !== 'string' || typeof q.question !== 'string')) return undefined;
      if (questions.some(q => q.isSecret)) return { text: 'Codex requested secret input. Enter it through the service’s trusted login flow; this connector does not collect secret answers.', deny };
      return { text: 'Codex needs your input:\n' + questions.map(q => `${q.id}: ${q.question}` +
        (q.options?.length ? '\n' + q.options.map((o: any) => `- ${o.label}: ${o.description}`).join('\n') : '')).join('\n\n'),
      deny, answerHint: questions.length === 1 ? '<text or option label>' : '{"question_id":"answer", ...}',
      answer: text => {
        const values = questions.length === 1 ? { [questions[0].id]: text } : objectAnswer(text);
        if (Object.keys(values).some(key => !questions.some(q => q.id === key))) throw new PublicError('Unknown question ID.');
        const answers: Record<string, { answers: string[] }> = Object.create(null);
        for (const q of questions) {
          if (typeof values[q.id] !== 'string' || !values[q.id].trim()) throw new PublicError('Provide a non-empty text answer for every question.');
          answers[q.id] = { answers: [values[q.id]] };
        }
        return { answers };
      } };
    }
    case 'mcpServer/elicitation/request': {
      const header = `MCP service: ${p.serverName}\n${p.message || p.description || ''}`;
      if (p.mode === 'url') {
        let url: URL;
        try { url = new URL(p.url); } catch { return undefined; }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
        return { text: `${header}\nOpen this service-provided link in your browser:\n${url.href}\nApprove only after completing the browser step. This acknowledges the link; it does not certify successful authentication.`,
          approve: { action: 'accept', content: null, _meta: null }, deny };
      }
      if (p.mode !== 'form') return { text: `${header}\nThis verification/form type (${p.mode}) requires a supported service UI. Approval in Matrix is unavailable.`, deny };
      const schema = p.requestedSchema;
      if (!record(schema) || schema.type !== 'object' || !record(schema.properties)) return undefined;
      return { text: `${header}\nRequested fields (JSON schema):\n${json(schema)}\nSend only the fields you choose; defaults are not submitted automatically.`,
        deny, answerHint: '{"field":"value", ...}', answer: text => {
          const content = objectAnswer(text);
          if (Object.keys(content).some(key => !Object.hasOwn(schema.properties, key)) ||
              (schema.required || []).some((key: string) => !Object.hasOwn(content, key))) throw new PublicError('Check required fields and remove unknown fields.');
          for (const [key, value] of Object.entries(content)) validateField(value, schema.properties[key]);
          return { action: 'accept', content, _meta: null };
        } };
    }
  }
}

function validateField(value: unknown, schema: any): void {
  const invalid = () => { throw new PublicError('An answer does not match its field type, allowed values, or limits.'); };
  if (!record(schema)) return invalid();
  // MCP titled multi-select items have anyOf/const without a type field.
  if (schema.type === undefined && Array.isArray(schema.anyOf)) {
    if (typeof value !== 'string' || !schema.anyOf.some((option: any) => option.const === value)) return invalid();
    return;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return invalid();
    const length = Array.from(value).length;
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Infinity)) return invalid();
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') return invalid();
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return invalid();
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return invalid();
    for (const entry of value) validateField(entry, schema.items);
    if (schema.uniqueItems && new Set(value).size !== value.length) return invalid();
  } else return invalid();
  if (schema.enum && !schema.enum.includes(value)) return invalid();
  if (schema.oneOf && !schema.oneOf.some((option: any) => option.const === value)) return invalid();
  if (schema.anyOf && !schema.anyOf.some((option: any) => option.const === value)) return invalid();
}
