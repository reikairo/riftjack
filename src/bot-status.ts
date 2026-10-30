import type { Config } from './config.js';
import type { Session } from './state.js';

export type EngineReport = {
  reportedAt: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  cwd?: string;
  permissionMode?: string;
  fastMode?: string;
  fastModeRequested?: string;
  fastModeDisabledReason?: string;
};

// Keep only display metadata, never the complete CLI response or its credentials.
export function engineReport(fields: Record<string, unknown>): EngineReport {
  const result: EngineReport = { reportedAt: new Date().toISOString() };
  for (const key of ['model', 'reasoningEffort', 'serviceTier', 'cwd', 'permissionMode', 'fastMode', 'fastModeRequested', 'fastModeDisabledReason'] as const) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim() && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value)) result[key] = value;
  }
  return result;
}

// Update only top-level Claude session/result metadata. A new init replaces the
// old report; a result replaces the fast-state/reason pair, preserving session
// metadata. Missing result fields from older CLIs leave the init report intact.
export function claudeEngineReport(message: Record<string, unknown>, tier: string | undefined, previous?: EngineReport): EngineReport | undefined {
  if (message.parent_tool_use_id) return;
  const requested = tier === 'fast' ? 'on' : tier === 'default' ? 'off' : 'inherited from Claude settings';
  if (message.type === 'system' && message.subtype === 'init') return engineReport({
    model: message.model, cwd: message.cwd, reasoningEffort: message.effort, permissionMode: message.permissionMode,
    fastModeRequested: requested, fastMode: message.fast_mode_state, fastModeDisabledReason: message.fast_mode_disabled_reason,
  });
  if (message.type !== 'result' || (!Object.hasOwn(message, 'fast_mode_state') && !Object.hasOwn(message, 'fast_mode_disabled_reason'))) return;
  return engineReport({ ...previous, fastModeRequested: requested,
    fastMode: message.fast_mode_state, fastModeDisabledReason: message.fast_mode_disabled_reason });
}

const fastModeReasons = new Map([
  ['preference', 'Disabled by the account/organization preference or managed policy. Check organization Claude Code settings and managed fastMode settings.'],
  ['extra_usage_disabled', 'Usage credits are not enabled. Check the account or organization Usage settings. Fast mode on a subscription uses separately billed credits.'],
  ['free', 'The account is not eligible: a paid subscription or paid Console account is required.'],
  ['network_error', 'Claude could not check fast-mode availability. Check connectivity to api.anthropic.com and proxy settings.'],
  ['pending', 'Claude is still checking fast-mode availability.'],
  ['not_first_party', 'Fast mode is unavailable through the selected provider in this Claude CLI.'],
  ['disabled_by_env', 'Fast mode is disabled by the Claude environment or unavailable in this CLI environment.'],
  ['model_not_allowed', 'The fast-mode model is excluded by the organization model policy.'],
  ['sdk_opt_in_required', 'This non-interactive session requires explicit fast-mode opt-in. Check the launch settings and Claude version.'],
  ['unknown', 'Claude could not determine fast-mode availability.'],
]);

function fastModeStatus(report: EngineReport): string[] {
  const rows = [`- Fast mode requested at launch: ${display(report.fastModeRequested, 'unknown (older report)')}`,
    `- Fast mode: ${display(report.fastMode, 'unknown (not reported)')}`];
  if (report.fastMode === 'on') return rows;
  if (report.fastMode === 'cooldown') rows.push('- Fast mode is temporarily cooling down; Claude may use standard speed.');
  if (report.fastModeDisabledReason) {
    rows.push(`- Fast-mode reason code: ${display(report.fastModeDisabledReason, 'not reported')}`);
    rows.push(`- Explanation: ${fastModeReasons.get(report.fastModeDisabledReason) ?? 'Unrecognized Claude reason. The code above is preserved for diagnosis.'}`);
  } else if (report.fastMode === 'off') {
    rows.push('- Fast-mode reason: not reported by Claude; no account or billing cause can be inferred.');
  }
  if (report.fastModeRequested === 'on' && report.fastMode !== 'on') rows.push('- Fast mode was requested, but this report does not confirm it is active.');
  return rows;
}

function display(value: string | undefined, fallback: string): string {
  return (value || fallback).replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, '\\$&');
}

export function botStatus(kind: 'codex' | 'claude' | 'pi', config: Config, session: Session): string {
  if (kind === 'pi') return [
    '**Pi status**',
    `- Workspace: ${display(config.workspace, 'unknown')}`,
    `- Configured model: ${display(config.piModel, 'CLI default')}`,
    `- Last reported model: ${display(session.piReport?.model, 'not reported')}`,
    `- Reported at: ${display(session.piReport?.reportedAt, 'not reported')}`,
    `- Shell/file writes: ${config.sandbox === 'read-only' || config.piApprovalPolicy === 'never' ? 'disabled' : 'Matrix confirmation per call'}`,
    '- Pi does not supply an OS sandbox.',
    `- Session: ${display(session.pi, 'not started')}`,
  ].join('\n');
  const codex = kind === 'codex';
  const report = codex ? session.codexReport : session.claudeReport;
  const row = (label: string, value?: string, fallback = 'unknown (not reported)') => `- ${label}: ${display(value, fallback)}`;
  const configured = 'automatic (inherited from CLI settings)';
  const settings = [
    row('Workspace', config.workspace),
    row('Model', codex ? config.codexModel : config.claudeModel, configured),
    ...(codex ? [row('Reasoning', config.codexReasoningEffort, configured)] : []),
    row('Service tier', codex ? config.codexServiceTier : config.claudeServiceTier, configured),
  ].join('\n');
  const reported = report ? [
    row('Reported at', report.reportedAt),
    row('Model', report.model), row('Workspace', report.cwd),
    row('Reasoning', report.reasoningEffort),
    ...(codex ? [row('Service tier', report.serviceTier)] : [...fastModeStatus(report), row('Permission mode', report.permissionMode)]),
  ].join('\n') + '\n\nThis is the last session report, not a live query. Settings may have changed since then.'
    : 'No report yet. Values will appear when the CLI starts a task in this conversation.';
  return [
    `**${codex ? 'Codex' : 'Claude Code'} status**`,
    '**Riftjack settings**', settings,
    '**Last CLI session report**', reported,
  ].join('\n\n');
}
