import type { Config } from './config.js';
import { PublicError } from './errors.js';

export type EngineSettings = { model?: string; reasoning?: string; tier?: string };
export function validateEngineSettings(value: unknown, kind: string): asserts value is EngineSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['codex', 'claude', 'pi'].includes(kind)) {
    throw new PublicError('Model settings are supported for Codex, Claude and Pi bots. Pi supports model and reasoning selection.');
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!(kind === 'pi' ? ['model', 'reasoning'] : ['model', 'tier', 'reasoning']).includes(key) ||
        typeof entry !== 'string' || !(key === 'model' ? /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,127}$/ : /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/).test(entry)) {
      throw new PublicError('Invalid model setting. Use model or tier identifiers; reasoning settings are supported for Codex, Claude and Pi bots.');
    }
    if (kind === 'pi' && key === 'reasoning' && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(entry)) {
      throw new PublicError('Pi reasoning must be off, minimal, low, medium, high, xhigh or max. Query options for levels supported by the selected model.');
    }
    if (kind === 'claude' && key === 'reasoning' && !['low', 'medium', 'high', 'xhigh', 'max'].includes(entry)) {
      throw new PublicError('Claude reasoning must be low, medium, high, xhigh or max.');
    }
    if (kind === 'claude' && key === 'tier' && !['default', 'fast'].includes(entry)) {
      throw new PublicError('Claude tier must be default or fast. Use reset tier bot Research to inherit the shared or CLI setting.');
    }
  }
}

export function withEngineSettings(config: Config, account: { kind: string; engineSettings?: EngineSettings }): Config {
  const settings = account.engineSettings ?? {};
  if (account.kind === 'codex') return { ...config,
    codexModel: settings.model ?? config.codexModel,
    codexReasoningEffort: settings.reasoning ?? config.codexReasoningEffort,
    codexServiceTier: settings.tier ?? config.codexServiceTier };
  if (account.kind === 'claude') return { ...config, claudeModel: settings.model ?? config.claudeModel,
    claudeReasoningEffort: settings.reasoning ?? config.claudeReasoningEffort,
    claudeServiceTier: settings.tier ?? config.claudeServiceTier };
  if (account.kind === 'pi') return { ...config, piModel: settings.model ?? config.piModel, piReasoningEffort: settings.reasoning ?? config.piReasoningEffort };
  return { ...config };
}
