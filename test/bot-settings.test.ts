import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../src/accounts.js';
import { loadConfig } from '../src/config.js';
import { manageBotSettings, parseBotSettingsRequest, showBotOptions } from '../src/bot-settings.js';
import { withEngineSettings } from '../src/engine-settings.js';
import { botStatus } from '../src/bot-status.js';

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'accounts.json');
  const accounts = new Accounts(file);
  for (const kind of ['codex', 'claude', 'grok', 'manager', 'pi'] as const) accounts.add({
    userId: `@${kind}:test`, name: kind, kind, accessToken: 'test-token', inviteUserId: '@creator:test',
  });
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test',
    RIFTJACK_WORKSPACE: dir, CODEX_MODEL: 'shared-model', CODEX_REASONING_EFFORT: 'high', CODEX_SERVICE_TIER: 'default', CLAUDE_MODEL: 'shared-claude' });
  const options = { accounts, config, sender: '@owner:test', owner: '@owner:test' };
  const run = (text: string, sender = options.sender) => manageBotSettings(parseBotSettingsRequest(text)!, { ...options, sender });
  return { file, accounts, config, run };
}

test('settings commands support quoted names and reject incomplete or malformed commands', () => {
  assert.deepEqual(parseBotSettingsRequest('set model bot "Ready to work" to example-model'),
    { action: 'set', field: 'model', target: 'Ready to work', value: 'example-model' });
  assert.equal(parseBotSettingsRequest('list bots'), null);
  for (const bad of ['set model bot', 'set model bot Builder', 'set model bot Builder to', 'reset tier bot Builder to default', 'show settings bot']) {
    assert.throws(() => parseBotSettingsRequest(bad), /Use /);
  }
});

test('settings persist per bot, inherit defaults, reset one field and appear in status', t => {
  const f = setup(t);
  f.run('set model bot codex to personal-model', '@creator:test');
  f.run('set reasoning bot codex to medium');
  f.run('set tier bot codex to priority');
  f.run('set model bot claude to sonnet[1m]');
  f.run('set model bot claude to personal-claude');
  const accounts = new Accounts(f.file);
  const codex = accounts.list()[0];
  const effective = withEngineSettings(f.config, codex);
  assert.equal(effective.codexModel, 'personal-model');
  assert.equal(effective.codexReasoningEffort, 'medium');
  assert.equal(effective.codexServiceTier, 'priority');
  assert.equal(effective.claudeModel, 'shared-claude');
  assert.match(botStatus('codex', effective, {}), /personal\\-model/);
  assert.equal(withEngineSettings(f.config, accounts.list()[1]).claudeModel, 'personal-claude');
  assert.equal(withEngineSettings(f.config, { kind: 'codex' }).codexModel, 'shared-model');
  codex.engineSettings!.model = 'mutated-copy';
  assert.equal(accounts.list()[0].engineSettings!.model, 'personal-model');
  const reset = f.run('reset model bot codex');
  assert.match(reset, /shared-model.*inherited/);
  assert.match(reset, /priority.*bot override/);
  assert.equal(f.accounts.list()[0].engineSettings!.model, undefined);
  assert.equal(f.config.codexModel, 'shared-model');
  const before = readFileSync(f.file, 'utf8');
  assert.match(f.run('show settings bot codex'), /medium/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('authorization, unsupported engines and invalid values leave settings untouched', t => {
  const f = setup(t), before = readFileSync(f.file, 'utf8');
  assert.throws(() => f.run('set model bot codex to example', '@other:test'), /Only/);
  for (const text of ['set model bot grok to example', 'set model bot manager to example', 'set tier bot claude to priority',
    'set reasoning bot claude to invalid', 'set model bot codex to --flag', 'set model bot codex to ' + 'x'.repeat(129)]) assert.throws(() => f.run(text));
  assert.equal(readFileSync(f.file, 'utf8'), before);
  f.accounts.add({ ...f.accounts.list()[0], userId: '@duplicate:test' });
  assert.throws(() => f.run('set model bot codex to example'), /Several bots/);
  assert.match(f.run('set model bot @codex:test to example'), /example/);
});

test('malformed stored settings fail validation on startup', t => {
  const f = setup(t), original = JSON.parse(readFileSync(f.file, 'utf8'));
  for (const settings of [null, [], { model: '' }, { model: 123 }, { model: 'line\nbreak' }, { typo: 'x' }]) {
    const data = structuredClone(original); data[0].engineSettings = settings;
    writeFileSync(f.file, JSON.stringify(data));
    assert.throws(() => new Accounts(f.file));
  }
  original[1].engineSettings = { reasoning: 'invalid' };
  writeFileSync(f.file, JSON.stringify(original));
  assert.throws(() => new Accounts(f.file));
});


test('Claude tier persists, explicitly disables fast mode and resets without changing other bots or model settings', t => {
  const f = setup(t);
  const codexBefore = f.accounts.list()[0];
  f.run('set model bot claude to personal-claude');
  assert.match(f.run('set tier bot claude to fast', '@creator:test'), /tier:.*fast.*bot override/);
  let account = new Accounts(f.file).list()[1];
  assert.equal(account.engineSettings!.tier, 'fast');
  let effective = withEngineSettings(f.config, account);
  assert.equal(effective.claudeServiceTier, 'fast');
  assert.match(botStatus('claude', effective, {}), /Service tier: fast/);
  assert.match(f.run('set tier bot claude to default'), /tier:.*default.*bot override/);
  account = new Accounts(f.file).list()[1];
  effective = withEngineSettings({ ...f.config, claudeServiceTier: 'fast' }, account);
  assert.equal(effective.claudeServiceTier, 'default');
  assert.match(f.run('reset tier bot claude'), /tier: automatic.*inherited/);
  account = new Accounts(f.file).list()[1];
  assert.equal(account.engineSettings!.tier, undefined);
  assert.equal(account.engineSettings!.model, 'personal-claude');
  assert.equal(withEngineSettings(f.config, account).claudeServiceTier, undefined);
  assert.equal(withEngineSettings({ ...f.config, claudeServiceTier: 'fast' }, account).claudeServiceTier, 'fast');
  assert.deepEqual(f.accounts.list()[0], codexBefore);
  const before = readFileSync(f.file, 'utf8');
  assert.throws(() => f.run('set tier bot claude to fast', '@other:test'), /Only/);
  assert.throws(() => f.run('set tier bot claude to priority'), /default or fast/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('Claude shared tier validates values and remains unset by default', t => {
  const f = setup(t);
  const env = { MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: f.config.workspace };
  assert.equal(loadConfig(env).claudeServiceTier, undefined);
  assert.equal(loadConfig({ ...env, CLAUDE_SERVICE_TIER: ' fast ' }).claudeServiceTier, 'fast');
  assert.equal(loadConfig({ ...env, CLAUDE_SERVICE_TIER: 'default' }).claudeServiceTier, 'default');
  assert.equal(loadConfig({ ...env, CLAUDE_SERVICE_TIER: ' ' }).claudeServiceTier, undefined);
  assert.throws(() => loadConfig({ ...env, CLAUDE_SERVICE_TIER: 'priority' }), /CLAUDE_SERVICE_TIER/);
  const original = JSON.parse(readFileSync(f.file, 'utf8'));
  original[1].engineSettings = { tier: 'priority' };
  writeFileSync(f.file, JSON.stringify(original));
  assert.throws(() => new Accounts(f.file), /default or fast/);
});

test('Claude reasoning persists, inherits and resets independently of model, tier and Codex', t => {
  const f = setup(t), codexBefore = f.accounts.list()[0];
  f.run('set model bot claude to personal-claude');
  f.run('set tier bot claude to fast');
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.match(f.run('set reasoning bot claude to ' + level, '@creator:test'), new RegExp('reasoning:.*' + level + '.*bot override'));
    const account = new Accounts(f.file).list()[1];
    assert.equal(account.engineSettings!.reasoning, level);
    const effective = withEngineSettings({ ...f.config, claudeReasoningEffort: 'medium' }, account);
    assert.equal(effective.claudeReasoningEffort, level);
    assert.match(botStatus('claude', effective, {}), new RegExp('Reasoning: ' + level));
  }
  const before = readFileSync(f.file, 'utf8');
  assert.match(f.run('show settings bot claude'), /reasoning:.*max.*bot override/);
  assert.throws(() => f.run('set reasoning bot claude to low', '@other:test'), /Only/);
  for (const value of ['invalid', 'HIGH', 'none', '--help']) assert.throws(() => f.run('set reasoning bot claude to ' + value));
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.match(f.run('reset reasoning bot claude'), /reasoning: automatic.*inherited/);
  const account = new Accounts(f.file).list()[1];
  assert.equal(withEngineSettings(f.config, account).claudeReasoningEffort, undefined);
  assert.equal(withEngineSettings({ ...f.config, claudeReasoningEffort: 'medium' }, account).claudeReasoningEffort, 'medium');
  assert.deepEqual(account.engineSettings, { model: 'personal-claude', tier: 'fast' });
  assert.deepEqual(f.accounts.list()[0], codexBefore);
});

test('Claude shared reasoning validates levels and defaults to CLI inheritance', t => {
  const f = setup(t);
  const env = { MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: f.config.workspace };
  assert.equal(loadConfig(env).claudeReasoningEffort, undefined);
  assert.equal(loadConfig({ ...env, CLAUDE_REASONING_EFFORT: ' ' }).claudeReasoningEffort, undefined);
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(loadConfig({ ...env, CLAUDE_REASONING_EFFORT: ' ' + level + ' ' }).claudeReasoningEffort, level);
  }
  assert.throws(() => loadConfig({ ...env, CLAUDE_REASONING_EFFORT: 'invalid' }), /CLAUDE_REASONING_EFFORT/);
});


test('option discovery resolves and authorizes the bot before reading its catalog, without changing settings', async t => {
  const f = setup(t), signal = new AbortController().signal;
  const workspace = join(f.config.workspace, 'project');
  mkdirSync(workspace);
  f.accounts.add({userId: '@project:test', kind: 'codex', name: 'Project', workspace,
    accessToken: 'test-token', inviteUserId: '@creator:test', engineSettings: {model: 'project-model'}});
  const before = readFileSync(f.file, 'utf8');
  const options = {...f, owner: '@owner:test', sender: '@creator:test', signal};
  let reads = 0;
  const read = async (config: typeof f.config, received: AbortSignal) => {
    reads++;
    assert.equal(config.workspace, workspace);
    assert.equal(config.codexModel, 'project-model');
    assert.equal(received, signal);
    return 'model catalog';
  };
  const readers = {codex: read, claude: async () => 'claude-catalog', pi: async () => 'pi-catalog'};
  const text = await showBotOptions('Project', options, readers);
  assert.match(text, /model catalog/);
  assert.match(text, /set reasoning.*EFFORT/);
  assert.match(text, /reset model/);
  assert.match(text, /auto_review/);
  await assert.rejects(showBotOptions('Project', {...options, sender: '@other:test'}, readers), /Only/);
  for (const target of ['grok', 'manager']) await assert.rejects(showBotOptions(target, {...options, sender: '@owner:test'}, readers), /supported/);
  assert.equal(reads, 1);
  assert.match(await showBotOptions('claude', options, readers), /claude-catalog/);
  assert.match(await showBotOptions('pi', options, readers), /pi-catalog/);
  assert.equal(reads, 1);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('options command accepts names and IDs and settings point to discovery', t => {
  const f = setup(t);
  assert.deepEqual(parseBotSettingsRequest('show options bot "Ready to work"'), {action:'options', target:'Ready to work'});
  assert.deepEqual(parseBotSettingsRequest('show options bot @codex:test'), {action:'options', target:'@codex:test'});
  assert.throws(() => parseBotSettingsRequest('show options bot'), /Use/);
  assert.match(f.run('show settings bot codex'), /show options bot @codex:test/);
  assert.match(botStatus('codex', {...f.config, codexApprovalsReviewer: 'auto_review'}, {}), /Approval reviewer: auto\\_review/);
});


test('Pi reasoning supports per-bot overrides, inheritance and reset while tiers remain unavailable', t => {
  const f = setup(t);
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    f.run('set reasoning bot pi to ' + level);
    assert.equal(withEngineSettings(f.config, f.accounts.list().find(x => x.kind === 'pi')!).piReasoningEffort, level);
  }
  assert.throws(() => f.run('set reasoning bot pi to wrong'));
  assert.throws(() => f.run('set tier bot pi to default'));
  assert.match(f.run('reset reasoning bot pi'), /reasoning: automatic/);
  const env = {MATRIX_HOMESERVER:'https://example.org', MATRIX_OWNER_ID:'@owner:example.org', RIFTJACK_WORKSPACE:f.config.workspace};
  assert.equal(loadConfig({...env, PI_REASONING_EFFORT:' high '}).piReasoningEffort,'high');
  assert.throws(() => loadConfig({...env, PI_REASONING_EFFORT:'wrong'}), /PI_REASONING_EFFORT/);
});
