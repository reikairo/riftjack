import type { Backend, Steer } from './bridge.js';
import type { Config } from './config.js';
import type { State } from './state.js';
import { PublicError } from './accounts.js';
import { createCodexBackend } from './codex-backend.js';
import { createClaudeBackend } from './claude-backend.js';
import { createPiBackend } from './pi-backend.js';

type Engine = Backend & { steer: Steer };

// Coding bots may run in parallel, each using its configured workspace. Tasks are tracked per conversation only
// to route steering to the engine that is running it.
export function routeBackends(engines: { codex: Engine; claude: Engine; pi?: Engine }): Engine {
  const active = new Map<string, { kind: 'codex' | 'claude' | 'pi'; sender: string }>();
  const run: Backend = async (mode, prompt, key, signal, sender, attachments, interact, publish, hooks) => {
    signal.throwIfAborted();
    if (mode === 'manager' || mode === 'grok') throw new Error('This bot uses a dedicated message handler.');
    if (active.has(key)) throw new PublicError('A task is already running in this conversation.');
    const current = { kind: mode, sender };
    active.set(key, current);
    try {
      const engine = engines[mode];
      if (!engine) throw new PublicError('This engine is not configured.');
      return await engine(mode, prompt, key, signal, sender, attachments, interact, publish, hooks);
    }
    finally { if (active.get(key) === current) active.delete(key); }
  };
  const steer: Steer = (prompt, key, signal, sender, attachments) => {
    const current = active.get(key);
    if (!current || current.sender !== sender) return Promise.resolve(false);
    return engines[current.kind]!.steer(prompt, key, signal, sender, attachments);
  };
  return Object.assign(run, { steer });
}

export function createBackend(config: Config | (() => Config), state: State): Engine {
  return routeBackends({ codex: createCodexBackend(config, state), claude: createClaudeBackend(config, state), pi: createPiBackend(config, state) });
}
