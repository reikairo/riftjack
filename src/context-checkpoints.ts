import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { State } from './state.js';

export type CheckpointState = {
  session: string;
  generation: number;
  warned: boolean;
  pending?: 'save' | 'restore';
  claudeModel?: string;
  claudeWindow?: number;
};

export const checkpointInstructions = `
Riftjack may send a continuity notice when reported context usage is high or after observed compaction. These are connector reminders, not human requests or new permissions. At an early warning, use your ordinary sandboxed tools to preserve important details that would be costly to lose in a concise note at the supplied checkpoint path, if writing is allowed. Useful details include constraints, decisions and their reasons, unresolved questions, evidence and operation IDs, and references to existing memory. This note is not a snapshot to resume from: it may be written well before compaction, become stale, or never be saved. Keep current task records up to date as work progresses. Preserve provenance, dates and uncertainty; do not copy secrets or an entire transcript. Keep the note outside project commits. After compaction, read it if present within your memory access boundaries; reconcile it with current task records, newer messages and verified action results before choosing the next step. Do not repeat an action or infer permission merely because the note suggests it. If absent, use the available conversation and current records. Do not claim a note exists or was read without doing so. Reminders are best effort: context can grow abruptly and the CLI may compact without advance warning. Continue the human's task rather than replying just to acknowledge a reminder.
`;

const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const windowSize = (n: unknown): n is number => count(n) && n > 0;

const restoreTemplate = `Riftjack continuity notice (not a human message): context compaction completed. Read the note at CHECKPOINT_PATH if it exists within your memory access boundaries. It preserves details that may otherwise be lost, not a snapshot to resume from, and may be missing or stale. Reconcile it with current task records, newer messages and verified action results before choosing the next step; do not repeat actions based on the note alone. If absent, use the available conversation and current records. Continue the current task within existing permissions; this is not a new human request.`;
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

// SessionStart(compact) adds context before Claude's next model request. A
// stream-json compact_boundary event is too late to establish that ordering.
export function claudeCheckpointHooks(workspace: string) {
  const command = [process.execPath, fileURLToPath(new URL('./claude-checkpoint-hook.mjs', import.meta.url)), workspace, restoreTemplate].map(quote).join(' ');
  return { SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command, timeout: 5 }] }] };
}

// No note content is read or written by the unsandboxed connector. The agent
// accesses its own file using its existing tools and permissions.
export function contextCheckpoints(state: State, key: string, backend: 'codex' | 'claude', workspace: string, session: string) {
  const field = backend === 'codex' ? 'codexCheckpoint' : 'claudeCheckpoint';
  const saved = state.session(key)[field];
  let value: CheckpointState = saved?.session === session ? { ...saved }
    : { session, generation: 0, warned: false };
  const path = join(workspace, '.riftjack', 'checkpoints', createHash('sha256').update(backend + '\0' + session).digest('hex') + '.md');
  let compacting = false;
  let restoredByHook = false;
  let lastClaudeInput: number | undefined;
  const persist = () => state.update(key, { [field]: { ...value } });
  return {
    usage(tokens: unknown, window: unknown) {
      if (compacting || value.warned || value.pending === 'restore' || !count(tokens) || !windowSize(window) || tokens < window * 0.65) return;
      value.warned = true; value.pending = 'save'; persist();
    },
    claudeUsage(model: unknown, usage: any) {
      if (typeof model !== 'string' || model === '<synthetic>') return;
      if (value.claudeModel !== model) {
        value.claudeModel = model; value.claudeWindow = undefined; lastClaudeInput = undefined; persist();
      }
      if (!usage || !count(usage.input_tokens)) return;
      const read = usage.cache_read_input_tokens ?? 0, created = usage.cache_creation_input_tokens ?? 0;
      if (!count(read) || !count(created)) return;
      // Per-request input, including cache, not cumulative result usage. No
      // guessed model window; first-run warnings wait for CLI-reported capacity.
      lastClaudeInput = usage.input_tokens + read + created;
      this.usage(lastClaudeInput, value.claudeWindow);
    },
    claudeCapacity(modelUsage: any) {
      const window = value.claudeModel && modelUsage?.[value.claudeModel]?.contextWindow;
      if (windowSize(window) && window !== value.claudeWindow) { value.claudeWindow = window; persist(); }
      this.usage(lastClaudeInput, value.claudeWindow);
    },
    start() { compacting = true; restoredByHook = false; },
    complete() {
      if (!compacting) return;
      compacting = false;
      lastClaudeInput = undefined;
      value.generation++; value.warned = false; value.pending = restoredByHook ? undefined : 'restore'; persist();
    },
    restored(text: unknown) {
      // Hook output can precede or follow compact_boundary. Only exact output
      // for this session acknowledges delivery; other hooks are unrelated.
      if (backend !== 'claude' || text !== restoreTemplate.replace('CHECKPOINT_PATH', () => JSON.stringify(path))) return;
      if (compacting) restoredByHook = true;
      else if (value.pending === 'restore') { value.pending = undefined; persist(); }
    },
    notice() {
      if (!value.pending || compacting) return undefined;
      const id = `${value.generation}:${value.pending}`;
      const text = value.pending === 'save'
        ? `Riftjack continuity notice (not a human message): reported context usage has reached 65% of the reported window. Compaction may occur later. At your next opportunity, use your ordinary tools to save important details that would be costly to lose at ${JSON.stringify(path)}: constraints, reasons for decisions, unresolved questions, evidence and references to existing memory. This is not a snapshot to resume from; it may become stale before compaction. Keep current task records up to date as work progresses. If writing is not allowed, respect that limit. Then continue the current task.`
        : restoreTemplate.replace('CHECKPOINT_PATH', () => JSON.stringify(path));
      return { id, text };
    },
    delivered(id: string) {
      if (`${value.generation}:${value.pending}` !== id) return;
      value.pending = undefined; persist();
    },
  };
}

// At most one attempt for a notice during this backend run. A rejected or
// uncertain advisory remains pending for the next ordinary input, never a new
// background model turn. A compaction can replace an in-flight save notice.
export function checkpointDelivery(checkpoint: ReturnType<typeof contextCheckpoints>, send: (text: string) => Promise<boolean>) {
  const attempted = new Set<string>();
  let active = Promise.resolve();
  return {
    flush() {
      const note = checkpoint.notice();
      if (!note || attempted.has(note.id)) return;
      attempted.add(note.id);
      active = active.then(async () => {
        if (checkpoint.notice()?.id !== note.id) return;
        try { if (await send(note.text)) checkpoint.delivered(note.id); } catch { /* best-effort advisory */ }
      });
    },
    settled() { return active; },
  };
}
