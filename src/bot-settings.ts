import { Accounts } from './accounts.js';
import { resolveProfileTarget } from './bot-profile.js';
import { PublicError } from './errors.js';
import { inlineCode, markdownText } from './manager-format.js';
import { type EngineSettings, validateEngineSettings, withEngineSettings } from './engine-settings.js';
import type { Config } from './config.js';
import { configForWorkspace } from './workspace.js';
import { claudeModelOptions, piModelOptions } from './cli-models.js';
import { codexModelOptions } from './codex-models.js';

type SettingsRequest = { action: 'show' | 'options'; target: string } |
  { action: 'set' | 'reset'; target: string; field: keyof EngineSettings; value?: string };
const usage = 'Use set model bot Builder to MODEL, set reasoning bot Builder to high, set tier bot Builder to default, reset model bot Builder, show settings bot Builder, or show options bot Builder.';
export function parseBotSettingsRequest(text: string): SettingsRequest | null {
  const clean = text.trim();
  if (!/^(?:(?:set|reset) (?:model|reasoning|tier) bot|show (?:settings|options) bot)(?:\s|$)/i.test(clean)) return null;
  const choices = /^show options bot (?:"([^"\r\n]+)"|([^"\r\n]+))$/i.exec(clean);
  if (choices) return { action: 'options', target: (choices[1] ?? choices[2]).trim() };
  const show = /^show settings bot (?:"([^"\r\n]+)"|([^"\r\n]+))$/i.exec(clean);
  if (show) return { action: 'show', target: (show[1] ?? show[2]).trim() };
  const match = /^(set|reset) (model|reasoning|tier) bot (?:"([^"\r\n]+)"|([^"\r\n]+?))(?: to ([^\s]+))?$/i.exec(clean);
  if (!match || (match[1].toLowerCase() === 'set') !== !!match[5]) throw new PublicError(usage);
  return { action: match[1].toLowerCase() as 'set' | 'reset', field: match[2].toLowerCase() as keyof EngineSettings,
    target: (match[3] ?? match[4]).trim(), value: match[5] };
}

export function manageBotSettings(request: SettingsRequest, options: {
  accounts: Accounts; owner: string; sender: string; config: Config;
}): string {
  const bot = resolveProfileTarget(options.accounts, request.target, options.sender, options.owner);
  const settings = { ...bot.engineSettings };
  validateEngineSettings(settings, bot.kind);
  if (request.action === 'set' || request.action === 'reset') {
    if (request.action === 'reset') delete settings[request.field];
    else settings[request.field] = request.value!;
    validateEngineSettings(settings, bot.kind);
    options.accounts.setEngineSettings(bot.userId, settings);
  }
  const config = withEngineSettings(options.config, { ...bot, engineSettings: settings });
  const fields: [keyof EngineSettings, string | undefined][] = bot.kind === 'pi' ? [['model', config.piModel], ['reasoning', config.piReasoningEffort]] : bot.kind === 'codex'
    ? [['model', config.codexModel], ['reasoning', config.codexReasoningEffort], ['tier', config.codexServiceTier]]
    : [['model', config.claudeModel], ['reasoning', config.claudeReasoningEffort], ['tier', config.claudeServiceTier]];
  return `### Settings for ${markdownText(bot.name)}\n\n` + fields.map(([key, value]) =>
    `- ${key}: ${value ? inlineCode(value) : 'automatic (CLI settings)'} — ${settings[key] ? 'bot override' : 'inherited'}`).join('\n') +
    `\n\nUse ${inlineCode('show options bot ' + bot.userId)} for allowed values and model-specific reasoning levels. `
    + 'Changes apply to the next task; running tasks keep their settings. No restart or conversation reset is required. Model and option availability is checked by the CLI when a task starts.';
}

export async function showBotOptions(target: string, options: {
  accounts: Accounts; owner: string; sender: string; config: Config; signal: AbortSignal;
}, readers = {codex: codexModelOptions, claude: claudeModelOptions, pi: piModelOptions}): Promise<string> {
  const bot = resolveProfileTarget(options.accounts, target, options.sender, options.owner);
  validateEngineSettings(bot.engineSettings ?? {}, bot.kind);
  const config = withEngineSettings(configForWorkspace(options.config, bot.workspace), bot);
  const select = `Use ${inlineCode('set model bot ' + bot.userId + ' to MODEL')} to select a model; `
    + `use ${inlineCode('set reasoning bot ' + bot.userId + ' to EFFORT')} for effort. `
    + (bot.kind === 'pi' ? '' : `Use ${inlineCode('set tier bot ' + bot.userId + ' to TIER')} for service tier. `);
  const reset = select + `Use ${inlineCode('reset model bot ' + bot.userId)} to inherit the shared default again; `
    + (bot.kind === 'pi' ? 'the same reset command supports reasoning. ' : 'the same reset command supports reasoning and tier. ')
    + 'A blank shared value leaves the choice to the CLI. Catalog defaults can differ from configured overrides.';
  const catalog = await readers[bot.kind as 'codex' | 'claude' | 'pi'](config, options.signal);
  if (bot.kind === 'codex') return catalog + '\n\n' + reset
    + '\n\nApproval policy (host setting): `on-request`, `never`; default `on-request`. '
    + 'Approval reviewer (host setting): `user`, `auto_review`; default `user`. '
    + `Configured reviewer: ${inlineCode(config.codexApprovalsReviewer)}. These are configured in the host .env, not by model-setting commands.`;
  if (bot.kind === 'claude') return catalog + '\n\n' + reset
    + '\n\nPermission mode (host setting): `acceptEdits`, `auto`; default `acceptEdits`. '
    + `Configured mode: ${inlineCode(config.claudePermissionMode)}. Approval policy: ${inlineCode(config.claudeApprovalPolicy)}. `
    + 'Configure these in the host .env; auto requires writable mode, on-request policy and CLI/account support. Read-only and never remain restrictive.';
  return catalog + '\n\n' + reset;
}
