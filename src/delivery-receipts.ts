import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PublicError, errorMessage } from './errors.js';
import type { BackgroundTarget } from './background-tasks.js';

type Receipt = { id: string; scope: BackgroundTarget; kind: string; fingerprint: string; created: number;
  status: 'sent' | 'uncertain' | 'not_sent'; result: string };
export type ScopedReceipts = { run(id: string, content: string, send: () => Promise<string>): Promise<string>; read(id?: string): string };
const same = (a: BackgroundTarget, b: BackgroundTarget) => (['room', 'sender', 'thread', 'key', 'session'] as const).every(k => a[k] === b[k]);
export const deliveryId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);

// Persist uncertainty BEFORE entering a transport. Recovery never retries a send.
// Full receipts remain queryable even when the submitting MCP response was lost.
export class DeliveryReceipts {
  private records: Receipt[] = [];
  private pending = new Map<Receipt, Promise<string>>();
  constructor(private path: string) {
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.records) || data.records.length > 1000 || data.records.some((r: Receipt) =>
      !r || !deliveryId(r.id) || !r.scope || !['room', 'sender', 'key', 'session'].every(k => typeof r.scope[k as keyof BackgroundTarget] === 'string') ||
      !['attachments', 'rooms'].includes(r.kind) || !/^[a-f0-9]{64}$/.test(r.fingerprint) || !Number.isFinite(r.created) ||
      !['sent', 'uncertain', 'not_sent'].includes(r.status) || typeof r.result !== 'string')) throw new Error('Invalid delivery receipt store.');
    this.records = data.records;
  }
  private archivePath(scope: BackgroundTarget, kind: string, id: string) {
    const key = createHash('sha256').update(JSON.stringify([kind, scope.room, scope.sender, scope.thread ?? null, scope.key, scope.session, id])).digest('hex');
    return join(this.path + '.archive', key + '.json');
  }
  private archived(scope: BackgroundTarget, kind: string, id: string): Receipt | undefined {
    const file = this.archivePath(scope, kind, id);
    if (!existsSync(file)) return;
    const r: Receipt = JSON.parse(readFileSync(file, 'utf8'));
    if (r.id !== id || r.kind !== kind || !same(r.scope, scope) || !/^[a-f0-9]{64}$/.test(r.fingerprint) || typeof r.result !== 'string') {
      throw new Error('Invalid archived delivery receipt. Restore it before sending.');
    }
    return r;
  }
  // Keep full evidence on disk, including deduplication identity. Write archives
  // before shrinking the index: interruption may leave duplicates, never a gap.
  private archiveCompleted() {
    if (this.records.length < 800) return;
    const selected = this.records.filter(r => r.status !== 'uncertain' && !this.pending.has(r)).slice(0, this.records.length - 600);
    if (!selected.length) return;
    mkdirSync(this.path + '.archive', { recursive: true, mode: 0o700 });
    for (const r of selected) {
      const file = this.archivePath(r.scope, r.kind, r.id), bytes = JSON.stringify(r);
      if (existsSync(file)) {
        if (readFileSync(file, 'utf8') !== bytes) throw new Error('Archived receipt differs; retain the active index for inspection.');
      } else {
        writeFileSync(file + '.tmp', bytes, { mode: 0o600 }); renameSync(file + '.tmp', file);
      }
    }
    const previous = this.records;
    this.records = previous.filter(r => !selected.includes(r));
    try { this.save(); } catch (error) { this.records = previous; throw error; }
  }
  private save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path + '.tmp', JSON.stringify({ version: 1, records: this.records }), { mode: 0o600 });
    renameSync(this.path + '.tmp', this.path);
  }
  scoped(scope: BackgroundTarget, kind: 'attachments' | 'rooms'): ScopedReceipts {
    const visible = (r: Receipt) => r.kind === kind && same(scope, r.scope);
    return {
      read: id => {
        if (id !== undefined && !deliveryId(id)) throw new PublicError('Invalid delivery id.');
        const matches = this.records.filter(r => visible(r) && (id === undefined || r.id === id));
        if (id && !matches.length) { const archived = this.archived(scope, kind, id); if (archived) matches.push(archived); }
        if (id && !matches.length) throw new PublicError('Delivery not found in this conversation.');
        const describe = (r: Receipt) => ({ id: r.id, status: r.status, created: r.created, result: JSON.parse(r.result) });
        return JSON.stringify(id ? describe(matches[0]) : matches.slice(-20).reverse().map(describe));
      },
      run: (id, content, send) => {
        if (!deliveryId(id)) throw new PublicError('Supply a unique delivery id (1–80 letters, digits, underscore or hyphen).');
        const fingerprint = createHash('sha256').update(content).digest('hex');
        const previous = this.records.find(r => visible(r) && r.id === id) ?? this.archived(scope, kind, id);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new PublicError('This delivery id was already used with different content.');
          return this.pending.get(previous) ?? Promise.resolve(previous.result);
        }
        this.archiveCompleted();
        if (this.records.length >= 1000) throw new PublicError('Delivery receipt index is full of pending or uncertain outcomes. Inspect those outcomes before sending; no retained id was evicted.');
        const receipt: Receipt = { id, kind, scope: { ...scope }, fingerprint, created: Date.now(), status: 'uncertain',
          result: JSON.stringify({ delivery_id: id, status: 'uncertain', note: 'Delivery was admitted but its outcome is not recorded. Inspect the destination; this id will never be automatically resent.' }) };
        this.records.push(receipt);
        try { this.save(); } catch (error) { this.records.pop(); throw error; }
        const result = Promise.resolve().then(async () => {
          try {
            const value = JSON.parse(await send());
            const statuses = Array.isArray(value.files) ? value.files.map((f: { status: string }) => f.status) : [value.status];
            receipt.status = statuses.every((s: string) => s === 'sent') ? 'sent' : statuses.every((s: string) => s === 'not_sent') ? 'not_sent' : 'uncertain';
            receipt.result = JSON.stringify({ ...value, delivery_id: id });
          } catch (error) {
            receipt.result = JSON.stringify({ delivery_id: id, status: 'uncertain', error: errorMessage(error, 'Delivery outcome unknown; inspect the destination') });
          }
          // If persistence fails, the saved uncertainty remains conservative.
          // Do not replay a successful effect just to obtain a durable receipt.
          this.save();
          return receipt.result;
        }).finally(() => { this.pending.delete(receipt); });
        this.pending.set(receipt, result);
        return result;
      },
    };
  }
}
