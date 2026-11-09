import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { PublicError } from './errors.js';
import { inlineCode } from './manager-format.js';
import { claudeEnvironment, checkClaude } from './claude-backend.js';
import { piEnvironment, checkPi } from './pi-backend.js';

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const list = (values: string[]) => values.map(inlineCode).join(', ') || 'none reported';

// Metadata only: no prompt, resume, tool invocation, settings update or saved session.
// Resolve only after the child exits; cancellation/failure always reaps it.
function catalogRpc(config: Config, kind: 'claude' | 'pi', args: string[], signal: AbortSignal,
  requests: object[], consume: (message: any) => string | undefined): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(kind === 'claude' ? config.claudePath : config.piPath, args, {
      cwd: config.workspace, env: kind === 'claude' ? claudeEnvironment() : piEnvironment(), stdio: 'pipe',
    });
    let stopping = false;
    let buffer = '', size = 0, answer: string | undefined, failure: unknown;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      stopping = true;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    const fail = (error: unknown) => { failure ??= error; stop(); };
    const abort = () => fail(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', cause => fail(new PublicError(`Could not start ${kind} for model discovery. Check its executable and login on the host.`, { cause })));
    child.stdin.on('error', () => { if (answer === undefined) fail(new PublicError(`${kind} closed the model catalog connection.`)); });
    child.stderr.resume(); // Never forward credentials or raw CLI diagnostics.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (failure || answer !== undefined) return;
      size += Buffer.byteLength(chunk); buffer += chunk;
      if (size > 4 * 1024 * 1024) { fail(new PublicError(`${kind} model catalog exceeded its size limit.`)); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          const message: unknown = JSON.parse(line);
          if (!record(message)) throw new PublicError(`${kind} returned an invalid model catalog response.`);
          // Metadata must not turn into a prompt, tool call or permission exchange.
          if (['control_request', 'extension_ui_request', 'assistant', 'agent_start', 'tool_execution_start'].includes(message.type)) {
            throw new PublicError(`${kind} requested interactive work during model discovery. No approval was granted.`);
          }
          answer = consume(message);
          if (answer !== undefined) {
            child.stdin.end();
            // Claude's streaming print mode can reject EOF without a user
            // prompt. Close our metadata-only process like an SDK query.
            if (kind === 'claude') stop();
            else closeTimer = setTimeout(stop, 1000);
            break;
          }
        } catch (error) {
          fail(error instanceof PublicError ? error : new PublicError(`${kind} returned an invalid model catalog response.`));
          break;
        }
      }
    });
    child.once('close', code => {
      clearTimeout(killTimer); clearTimeout(closeTimer); signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (answer === undefined || (code !== 0 && !stopping)) reject(new PublicError(`${kind} did not return a complete model catalog. Check its installed version and login.`));
      else resolve(answer);
    });
    for (const request of requests) child.stdin.write(JSON.stringify(request) + '\n');
    if (signal.aborted) abort();
  });
}

export async function claudeModelOptions(config: Config, signal: AbortSignal): Promise<string> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  await checkClaude(config, signal);
  const id = randomUUID();
  return catalogRpc(config, 'claude', ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk', '--tools', '', '--no-session-persistence', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}'], signal,
  [{type: 'control_request', request_id: id, request: {subtype: 'initialize', hooks: null}}], message => {
    if (message.type !== 'control_response' || message.response?.request_id !== id) return;
    const response = message.response;
    if (response.subtype !== 'success') throw new PublicError('Claude could not list models. Check its login and control-protocol support.');
    const models = response.response?.models;
    if (!Array.isArray(models) || models.length > 1000) throw new PublicError('Claude returned an invalid model catalog.');
    if (!models.length) return 'Claude returned no selectable models. Check the account on the host.';
    const lines = models.map(model => {
      if (!record(model) || typeof model.value !== 'string' ||
          (model.supportedEffortLevels !== undefined && !strings(model.supportedEffortLevels))) {
        throw new PublicError('Claude returned an invalid model catalog.');
      }
      const effort = model.supportsEffort === false ? 'not supported' : model.supportedEffortLevels ? list(model.supportedEffortLevels) : 'not reported by this CLI';
      const fast = model.supportsFastMode === true ? '`default`, `fast`' : model.supportsFastMode === false ? '`default` (Fast mode unsupported)' : '`default`; Fast mode support not reported';
      return `- ${inlineCode(model.value)}${model.value === config.claudeModel ? ' (configured)' : ''}`
        + (typeof model.resolvedModel === 'string' ? ` → ${inlineCode(model.resolvedModel)}` : '')
        + `: reasoning: ${effort}; tier: ${fast}.`;
    });
    return '### Models and reasoning levels reported by Claude Code\n\n' + lines.join('\n')
      + '\n\nEffort defaults are not reported by this protocol. Blank values inherit CLI settings. No model turn was started.';
  });
}

export async function piModelOptions(config: Config, signal: AbortSignal): Promise<string> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  await checkPi(config, signal);
  const catalogId = randomUUID(), stateId = randomUUID(), levelsId = randomUUID();
  const pending = new Map([[catalogId, 'get_available_models'], [stateId, 'get_state'], [levelsId, 'get_available_thinking_levels']]);
  const data = new Map<string, any>();
  return catalogRpc(config, 'pi', ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-mcp', '--no-skills',
    '--no-prompt-templates', '--no-themes', ...(config.piModel ? ['--model', config.piModel] : []),
    ...(config.piReasoningEffort ? ['--thinking', config.piReasoningEffort] : [])], signal,
  [...pending].map(([id, type]) => ({id, type})), message => {
    if (message.type !== 'response' || !pending.has(message.id)) return;
    const command = pending.get(message.id)!;
    if (message.command !== command || message.success !== true) throw new PublicError(`Pi could not read ${command}. Update Pi or check its model configuration.`);
    pending.delete(message.id); data.set(command, message.data);
    if (pending.size) return;
    const models = data.get('get_available_models')?.models;
    const state = data.get('get_state'), levels = data.get('get_available_thinking_levels')?.levels;
    if (!Array.isArray(models) || models.length > 10000 || !record(state) || !strings(levels)) throw new PublicError('Pi returned an invalid model catalog.');
    if (!models.length) return 'Pi returned no configured models. Check provider login on the host.';
    const lines = models.map(model => {
      if (!record(model) || typeof model.id !== 'string' || typeof model.provider !== 'string') throw new PublicError('Pi returned an invalid model catalog.');
      const selected = state.model?.id === model.id && state.model?.provider === model.provider;
      return `- ${inlineCode(model.provider + '/' + model.id)}${selected ? ' (selected)' : ''}: reasoning: `
        + (selected ? list(levels) : model.reasoning === false ? 'off only' : 'select this model and query options again for exact levels') + '.';
    });
    return '### Models reported by Pi\n\n' + lines.join('\n')
      + '\n\nThinking levels are reported for the selected model only. '
      + (typeof state.thinkingLevel === 'string' ? `Current CLI thinking level: ${inlineCode(state.thinkingLevel)}. ` : '')
      + 'Riftjack exposes model and reasoning selection, but no service tier for Pi. No model turn was started.';
  });
}
