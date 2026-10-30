import type { Interaction } from './interactions.js';
import { confirmationDetails } from './confirmation-format.js';

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

export const CLAUDE_DENY = { behavior: 'deny', message: 'The user declined this action in Matrix.' };

// Fields shown in readable form per tool. Every other input field is still shown as JSON:
// an approval must never cover input the user did not see.
const readable: Record<string, [string, string][]> = {
  Bash: [['command', 'Command'], ['description', 'Description']],
  Edit: [['file_path', 'File'], ['old_string', 'Replace'], ['new_string', 'With']],
  Write: [['file_path', 'File'], ['content', 'Content']],
};

// Turns a Claude Code stream-json can_use_tool control request into a Matrix confirmation.
export function claudeInteraction(request: Record<string, any>): Interaction | undefined {
  if (request.subtype !== 'can_use_tool' || typeof request.tool_name !== 'string' || !record(request.input)) return;
  const { tool_name: tool, input } = request;
  const details: Parameters<typeof confirmationDetails>[0] = [{ value: `Claude Code requests permission to use ${tool}.` }];
  if (tool === 'Bash' && input.dangerouslyDisableSandbox === true) {
    details.push({ value: 'This command will run outside the Claude sandbox.', spaced: true });
  }
  if (request.decision_reason != null) details.push({ label: 'Reason', value: text(request.decision_reason), spaced: true });
  if (typeof request.blocked_path === 'string') details.push({ label: 'Blocked path', value: request.blocked_path, code: true });
  const shown = new Set<string>();
  for (const [key, label] of readable[tool] || []) {
    if (input[key] === undefined) continue;
    shown.add(key);
    const value = text(input[key]);
    details.push({ label, value, code: tool === 'Bash' && key === 'command' ? 'command' : key !== 'description' });
  }
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => !shown.has(key)));
  if (Object.keys(rest).length) details.push({ label: shown.size ? 'Other input' : 'Input', value: JSON.stringify(rest, null, 2), code: true });
  details.push({ value: 'This request only; no permanent rule.' });
  return { ...confirmationDetails(details), approve: { behavior: 'allow', updatedInput: input }, deny: CLAUDE_DENY };
}
