import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

type Stage = 'preparing' | 'running' | 'delivering';
type Outcome = 'completed' | 'failed' | 'cancelled' | 'interrupted';
type Entry = { id: string; key: string; event: string; started: number; updated: number; stage: Stage; outcome?: Outcome };
const stages: Stage[] = ['preparing', 'running', 'delivering'];
const outcomes: Outcome[] = ['completed', 'failed', 'cancelled', 'interrupted'];
const short = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(new Date(value).getTime());

// Connector stages, not an audit of engine tool calls or proof of task success.
// Nothing in this store is used to resume or replay a run.
export class RunJournal {
  private entries: Entry[];
  constructor(private file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, entries: [] };
    if (data?.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 100 || data.entries.some((e: any) =>
      !e || !short(e.id, 160) || !short(e.key, 4096) || !short(e.event, 1024) ||
      !timestamp(e.started) || !timestamp(e.updated) || e.updated < e.started ||
      !stages.includes(e.stage) || (e.outcome !== undefined && !outcomes.includes(e.outcome)))) {
      throw new Error('Invalid run journal. Restore it before restarting.');
    }
    this.entries = data.entries;
    if (this.entries.some(e => !e.outcome)) this.save(this.entries.map(e => e.outcome ? e
      : { ...e, outcome: 'interrupted', updated: Math.max(e.updated, Date.now()) }));
  }
  private save(entries: Entry[]) {
    writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, entries }), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
    this.entries = entries;
  }
  begin(key: string, event: string): string {
    if (!short(key, 4096) || !short(event, 1024)) throw new Error('Invalid run journal scope.');
    if (this.entries.filter(e => !e.outcome).length >= 100) throw new Error('Run journal is full of active runs.');
    const now = Date.now(), id = randomUUID();
    const active = this.entries.filter(e => !e.outcome);
    const slots = 99 - active.length;
    const finished = slots ? this.entries.filter(e => e.outcome).slice(-slots) : [];
    this.save([...active, ...finished, { id, key, event, started: now, updated: now, stage: 'preparing' }]);
    return id;
  }
  update(id: string, stage: Stage, outcome?: Outcome) {
    const entry = this.entries.find(e => e.id === id);
    if (!entry || entry.outcome) throw new Error('No active run journal entry.');
    this.save(this.entries.map(e => e === entry ? { ...e, stage, ...(outcome && { outcome }), updated: Math.max(e.updated, Date.now()) } : e));
  }
  summary(key: string): string {
    const items = this.entries.filter(e => e.key === key).slice(-5).reverse();
    if (!items.length) return '';
    return '\n\nRecent connector runs (latest 5):\n' + items.map(e =>
      `${e.id}: ${e.outcome ?? 'active'}; last stage: ${e.stage}; updated: ${new Date(e.updated).toISOString()}`).join('\n') +
      '\nCompleted means the connector finished handling the run, not that the task succeeded. Interrupted, failed or cancelled runs may have made changes or sent messages. Inspect results before retrying; runs are never replayed from this journal.';
  }
}
