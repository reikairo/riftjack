import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botStatus, engineReport, claudeEngineReport } from '../src/bot-status.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: process.cwd(),
  CODEX_MODEL: 'requested-model', CODEX_REASONING_EFFORT: 'high', CODEX_SERVICE_TIER: 'priority', CLAUDE_MODEL: 'requested-claude' });

test('status separates configured and reported settings and labels missing metadata', () => {
  const report = engineReport({ model: 'resolved-model', reasoningEffort: 'medium', serviceTier: 'default', cwd: '/projects/previous' });
  const text = botStatus('codex', config, { codexReport: report });
  const [settings, reported] = text.split('**Last CLI session report**');
  assert.match(settings, /requested\\-model/);
  assert.match(settings, /high/);
  assert.match(settings, /priority/);
  assert.match(reported, /resolved\\-model/);
  assert.match(reported, /medium/);
  assert.match(reported, /default/);
  assert.match(reported, /previous/);
  assert.match(reported, /not a live query/);
  assert.doesNotMatch(reported, /requested/);
  const claude = botStatus('claude', config, { claudeReport: engineReport({ model: 'claude-model' }) });
  assert.match(claude, /Reasoning: unknown/);
  assert.match(claude, /Fast mode: unknown/);
  assert.match(claude, /Service tier: automatic/);
  assert.match(botStatus('codex', config, {}), /No report yet/);
  assert.match(botStatus('claude', { ...config, claudeModel: undefined }, {}), /automatic/);
  assert.doesNotMatch(botStatus('claude', config, { codexReport: report }), /resolved/);
});

test('CLI reports whitelist metadata, reject malformed fields and escape Markdown', () => {
  const report = engineReport({ model: '[model](https://example.com)', cwd: '/projects/**demo**', reasoningEffort: null,
    serviceTier: { secret: 'private' }, fastMode: 'on\nsecret', permissionMode: 'x'.repeat(1025), accessToken: 'secret', thread: { turns: ['private'] } });
  assert.deepEqual(Object.keys(report).sort(), ['cwd', 'model', 'reportedAt']);
  const text = botStatus('codex', config, { codexReport: report });
  assert.ok(text.includes('\\[model\\]\\(https://example\\.com\\)'));
  assert.ok(text.includes('/projects/\\*\\*demo\\*\\*'));
  assert.doesNotMatch(text, /secret|private/);
});


test('Claude status separates requested fast mode from an account refusal and explains its exact reason', () => {
  const report = claudeEngineReport({ type: 'system', subtype: 'init', fast_mode_state: 'off',
    fast_mode_disabled_reason: 'preference' }, 'fast')!;
  const status = botStatus('claude', { ...config, claudeServiceTier: 'fast' }, { claudeReport: report });
  assert.match(status, /requested at launch: on/);
  assert.match(status, /Fast mode: off/);
  assert.match(status, /reason code: preference/);
  assert.match(status, /organization preference or managed policy/);
  assert.match(status, /does not confirm it is active/);
  assert.doesNotMatch(status, /credits|billing problem/);
});

test('fast-mode result snapshots clear stale reasons, retain session metadata and ignore child or absent metadata', () => {
  const initial = claudeEngineReport({ type: 'system', subtype: 'init', model: 'resolved-model',
    fast_mode_state: 'off', fast_mode_disabled_reason: 'pending' }, 'fast')!;
  const final = claudeEngineReport({ type: 'result', fast_mode_state: 'on' }, 'fast', initial)!;
  assert.equal(final.model, initial.model);
  assert.equal(final.fastModeDisabledReason, undefined);
  assert.equal(final.fastMode, 'on');
  assert.equal(claudeEngineReport({ type: 'result' }, 'fast', initial), undefined);
  assert.equal(claudeEngineReport({ type: 'result', parent_tool_use_id: 'child', fast_mode_state: 'off' }, 'fast', initial), undefined);
  const resumed = claudeEngineReport({ type: 'system', subtype: 'init' }, 'default', initial)!;
  assert.equal(resumed.fastModeRequested, 'off');
  assert.equal(resumed.model, undefined);
  assert.equal(resumed.fastModeDisabledReason, undefined);
  const text = botStatus('claude', config, { claudeReport: final });
  assert.doesNotMatch(text, /pending|reason code|does not confirm/);
});

test('unknown or omitted reasons are not guessed, and untrusted reason strings stay literal and bounded', () => {
  const status = (fastMode: string, fastModeDisabledReason?: unknown) => botStatus('claude', config,
    { claudeReport: engineReport({ fastModeRequested: 'on', fastMode, fastModeDisabledReason }) });
  assert.match(status('off'), /not reported by Claude/);
  assert.match(status('cooldown'), /temporarily cooling down/);
  assert.doesNotMatch(status('on', 'preference'), /reason code|Disabled by/);
  const text = status('off', '[future](https://example.com)');
  assert.match(text, /Unrecognized Claude reason/);
  assert.ok(text.includes('\\[future\\]'));
  for (const invalid of ['bad\nreason', 'x'.repeat(1025), { secret: 'private' }]) {
    const report = engineReport({ fastModeDisabledReason: invalid });
    assert.equal(report.fastModeDisabledReason, undefined);
  }
});

test('status explicitly separates backend tool support from configured availability', () => {
  for (const kind of ['codex', 'claude', 'pi'] as const) {
    const text = botStatus(kind, config, {});
    assert.match(text, /Supported connector tools/);
    assert.match(text, /Availability depends on configuration and permissions/);
    assert.match(text, /background_tasks/);
    if (kind === 'pi') assert.doesNotMatch(text, /run_detached|request_confirmation|drawio/);
    else assert.match(text, /run_detached/);
  }
});
