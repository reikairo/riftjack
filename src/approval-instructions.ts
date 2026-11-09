import { SAVE_INTENT } from './approval-intent.js';

// Guidance for the agent's decision before it asks for approval. This is not
// a command classifier or an enforcement boundary.
export function approvalInstructions(engine: 'codex' | 'claude', reviewer: 'user' | 'auto_review' = 'user'): string {
  if (engine === 'codex' && reviewer === 'auto_review') return '\nEligible Codex approval requests use automatic review. '
    + 'Request required permissions through the normal tool approval mechanism and explain their scope. '
    + 'Automatic review can approve or reject a request; it does not remove sandbox or managed restrictions. '
    + 'If automatic approval review rejects an action, tell the human which action was rejected and the stated reason. '
    + 'Do not bypass a rejection with another tool, wrapper, permission rule, or reviewer setting. '
    + 'Riftjack publication, detached-run, and explicit confirmation tools retain their own human confirmations. '
    + 'Forms, authentication, and other requests that still reach Matrix need the human response; do not answer them yourself.\n';
  if (engine === 'claude' && reviewer === 'auto_review') return '\nEligible Claude Code actions use its auto permission mode and classifier. '
    + 'Sandbox, explicit permission rules, and managed restrictions still apply. '
    + 'When a required command fails because of the sandbox, request a retry with dangerouslyDisableSandbox: true and explain the scope in the Bash description. '
    + 'If automatic review rejects an action, report the action and stated reason to the human; do not bypass it with another tool, wrapper, permission rule, or mode. '
    + 'Any permission prompt that still reaches Matrix needs the human response; do not answer it yourself. '
    + 'Riftjack publication, detached-run, and explicit confirmation tools retain their own human confirmations.\n';
  const common = '\nBefore each command approval request, assess whether a persistent permission would be appropriate, '
    + 'not just whether the current invocation is acceptable. Consider future matching arguments, executable resolution through PATH, '
    + 'configuration, hooks, plugins and other code the command may load. A stable command name or script path does not make its behavior immutable. '
    + 'If future runs could execute code the agent can change inside the sandbox, request one-time approval only. '
    + 'This includes running editable scripts, project tests and builds, and commands that load editable hooks or plugins. '
    + 'If uncertain, choose one-time approval. Do not broaden a prefix or create a wrapper to make a command eligible for a saved rule. '
    + 'Briefly explain the permission scope in the request. This assessment is your responsibility before each request; '
    + 'the connector does not classify command safety for you. Never edit permission rules yourself to avoid confirmation. ';
  return common + (engine === 'codex'
    ? 'When requesting escalation, omit prefix_rule for one-time-only approval. Supply a narrow prefix_rule only after this assessment '
      + 'supports future matching invocations. Codex may automatically propose a prefix even if you omit prefix_rule; that alone must not offer saving. '
      + 'To explicitly offer saving, also append a final standalone line to the justification in this format:\n' + SAVE_INTENT + '["exact", "prefix", "arguments"]\n'
      + 'Replace the JSON array with exactly the prefix_rule you assessed; put your explanation before that line. '
      + 'For one-time approval or uncertainty, omit this line as well as prefix_rule. The connector offers saving only when this explicit choice '
      + 'matches the server-proposed prefix exactly. Do not add the line merely because a prefix was suggested automatically. '
      + 'A proposed rule is not consent: the human must explicitly choose to save it.\n'
    : 'Riftjack currently supports only one-time Claude tool approvals; it does not save Claude permission rules. '
      + 'Do not promise a persistent grant or change settings to simulate one. '
      + 'When unsandboxed retries are enabled and a required command fails because of the sandbox, '
      + 'request a retry with dangerouslyDisableSandbox: true and explain the exact scope in the Bash description. '
      + 'Riftjack sends that request to the human for one-time confirmation. '
      + 'Before requesting a process signal, verify the current process identity and target only that process or its verified group.\n');
}
