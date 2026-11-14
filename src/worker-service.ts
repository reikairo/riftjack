import { diagnosticOperation } from './diagnostics.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { WorkerError, WorkerQueue, type WorkerTask, type WorkerFile } from './worker-queue.js';
import { readOutgoing, safeName, type IncomingAttachment } from './media.js';

export type WorkerTransport = {
  initiative?: { intervalMs: number; prepare: (source: WorkerTask, text: string, eventId: string) => WorkerTask };
  allowed: (task: WorkerTask) => Promise<boolean>;
  receive: (task: WorkerTask) => Promise<IncomingAttachment | undefined>;
  transcribe?: (file: IncomingAttachment, signal: AbortSignal) => Promise<IncomingAttachment>;
  prepare: (task: WorkerTask) => Promise<unknown[]>;
  send: (task: WorkerTask, transaction: string, encrypted: unknown) => Promise<string | void>;
  started?: () => Promise<void>;
  completed?: (task: WorkerTask, eventId: string) => Promise<void>;
  prompt?: (task: WorkerTask) => string;
  prompted?: () => void;
  roomAllowed?: (task: WorkerTask, room: string) => Promise<boolean>;
  rooms?: (task: WorkerTask, request: unknown, signal: AbortSignal, guard: () => Promise<void>, outbox: string) => Promise<string>;
  report: (error: unknown) => void;
};
export class WorkerService {
  private delivering = false;
  private stopped = false;
  private controller = new AbortController();
  private downloads = new Map<string, Promise<IncomingAttachment>>();
  constructor(readonly queue: WorkerQueue, private files: string, readonly maxBytes: number, private transport: WorkerTransport) {}
  get busy() { return this.delivering; }
  stop() { this.stopped = true; this.controller.abort(); }
  private async allowed(task: WorkerTask) {
    if (this.stopped) throw new WorkerError(503, 'Connector is stopping.');
    const allowed = (!task.initiative || !!this.transport.initiative) && await diagnosticOperation({ operation: 'worker.authorize', task: task.id, taskAttempt: task.attempt }, () => this.transport.allowed(task));
    if (this.stopped) throw new WorkerError(503, 'Connector is stopping.');
    if (!allowed) {
      this.queue.cancel(task.id);
      throw new WorkerError(403, 'Task access or room privacy changed.');
    }
  }
  async initiate(sourceId: string, input: unknown) {
    const option = this.transport.initiative;
    if (!option || !Number.isSafeInteger(option.intervalMs) || option.intervalMs < 60_000) {
      throw new WorkerError(403, 'Worker initiative is disabled by the owner.');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WorkerError(400, 'Expected an initiative request.');
    const { id, text } = input as { id?: unknown; text?: unknown };
    if (Object.keys(input).some(key => !['id', 'text'].includes(key)) ||
        typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id) ||
        typeof text !== 'string' || !text.trim() || text.length > 16_000) {
      throw new WorkerError(400, 'Supply an initiative id (1-80 letters, digits, _ or -) and text (1-16000 characters).');
    }
    const source = this.queue.get(sourceId);
    await this.allowed(source);
    const eventId = '$worker-initiative-' + createHash('sha256').update(JSON.stringify([source.conversation, id])).digest('hex');
    const task = option.prepare(source, text, eventId);
    // The destination is the conversation's home, which may differ from the
    // source task's shared room. Revalidate both after asynchronous checks.
    if (!(await diagnosticOperation({ operation: 'worker.authorize', task: task.id, taskAttempt: task.attempt }, () => this.transport.allowed(task)))) throw new WorkerError(403, 'Worker initiative destination is no longer allowed.');
    await this.allowed(source);
    const accepted = this.queue.enqueueInitiative(task, option.intervalMs);
    return { id: accepted.id, status: accepted.status, conversation: accepted.conversation };
  }
  async claim() {
    const candidate = this.queue.candidate();
    if (candidate) {
      try { await this.allowed(candidate); }
      catch (error) { if (error instanceof WorkerError && error.status === 403) return null; throw error; }
      const task = this.queue.claim(candidate.id);
      if (!task) return null;
      try { await diagnosticOperation({ operation: 'worker.started', task: task.id, taskAttempt: task.attempt }, async () => { await this.transport.started?.(); }); } catch (error) { this.transport.report(error); }
      await this.allowed(task);
      this.queue.checkLease(task.id, task.lease!);
      if (task.prompt === undefined && this.transport.prompt) {
        task.prompt = this.queue.cachePrompt(task.id, task.lease!, this.transport.prompt(task));
        this.transport.prompted?.();
      }
      return { id: task.id, room: task.room, type: task.context?.type ?? 'private', agents: task.context?.agents ?? [], conversation: task.conversation, sender: task.event.sender,
        text: task.prompt ?? task.event.content?.body ?? '', hasAttachment: !!task.event.content?.file,
        lease: task.lease, leaseUntil: task.leaseUntil, attempt: task.attempt };
    }
    return null;
  }
  async status(id: string) {
    const task = this.queue.get(id); await this.allowed(task);
    return { id, status: task.status, leaseUntil: task.leaseUntil, attempt: task.attempt };
  }
  async renew(id: string, lease: string) {
    await this.allowed(this.queue.checkLease(id, lease));
    return { leaseUntil: this.queue.renew(id, lease).leaseUntil };
  }
  async release(id: string, lease: string) {
    await this.allowed(this.queue.checkLease(id, lease)); this.queue.release(id, lease);
    return { released: true };
  }
  async attachment(id: string, lease: string) {
    let task = this.queue.checkLease(id, lease); await this.allowed(task);
    task = this.queue.checkLease(id, lease);
    let download = this.downloads.get(id);
    if (!task.attachment && !download) {
      download = (async () => {
        let file = await diagnosticOperation({ operation: 'worker.attachment', task: task.id, taskAttempt: task.attempt }, () => this.transport.receive(task));
        this.queue.checkLease(id, lease); await this.allowed(task);
        if (!file) throw new WorkerError(404, 'This task has no attachment.');
        if (this.transport.transcribe) {
          file = await this.transport.transcribe(file, this.controller.signal);
          this.queue.checkLease(id, lease); await this.allowed(task);
        }
        this.queue.cacheAttachment(id, lease, file);
        return file;
      })();
      this.downloads.set(id, download);
      void download.finally(() => { if (this.downloads.get(id) === download) this.downloads.delete(id); }).catch(() => {});
    }
    const file = task.attachment ?? await download!;
    const data = await readOutgoing({ path: file.path, root: dirname(file.path) }, this.maxBytes);
    // Cached reads still require a live lease and current room authorization.
    this.queue.checkLease(id, lease); await this.allowed(this.queue.get(id));
    this.queue.checkLease(id, lease);
    return { name: file.name, mimetype: file.mimetype, data: data.toString('base64'),
      ...(file.transcription && { transcription: file.transcription }) };
  }
  async complete(id: string, lease: string, body: unknown) {
    if (!body || typeof body !== 'object') throw new WorkerError(400, 'Expected a reply object.');
    const { text = '', files = [] } = body as { text?: unknown; files?: unknown };
    if (typeof text !== 'string' || text.length > 40_000 || !Array.isArray(files) || files.length > 10 || (!text.trim() && !files.length)) throw new WorkerError(400, 'Supply text (up to 40,000 characters) and/or up to 10 files.');
    const task = this.queue.get(id); await this.allowed(task);
    if (!['replied', 'delivered'].includes(task.status)) this.queue.checkLease(id, lease);
    else if (task.lease !== lease) throw new WorkerError(409, 'Different task lease.');
    const stored = this.storeFiles(files);
    const accepted = this.queue.complete(id, lease, text, stored);
    void this.deliver();
    return { id, status: accepted.status }; // Accepted is distinct from Matrix delivery.
  }
  private storeFiles(files: unknown): WorkerFile[] {
    if (!Array.isArray(files) || !files.length || files.length > 10) {
      if (Array.isArray(files) && !files.length) return [];
      throw new WorkerError(400, 'Supply up to 10 files.');
    }
    let total = 0;
    const decoded = files.map(file => {
      if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 255 || typeof file.data !== 'string' || (file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))) throw new WorkerError(400, 'Files need a name of at most 255 characters and base64 data.');
      const data = Buffer.from(file.data, 'base64'); total += data.length;
      if (total > this.maxBytes) throw new WorkerError(413, 'Reply attachments exceed the total size limit.');
      return { name: safeName(file.name), data };
    });
    mkdirSync(this.files, { recursive: true, mode: 0o700 });
    return decoded.map(({ name, data }) => {
      const directory = join(this.files, createHash('sha256').update(data).digest('hex'));
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, name);
      try { writeFileSync(path, data, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      return { name, path };
    });
  }
  async rooms(id: string, lease: string, input: unknown) {
    const guard = async () => {
      const current = this.queue.checkLease(id, lease);
      await this.allowed(current);
      this.queue.checkLease(id, lease);
    };
    await guard();
    if (!this.transport.rooms) throw new WorkerError(403, 'Linked room operations are not configured.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WorkerError(400, 'Expected a room request.');
    let request = { ...input } as Record<string, unknown>;
    if (['send', 'send_files', 'continue_private'].includes(String(request.action))) this.queue.roomOperation(id, lease, request.id);
    if (request.action === 'send_files') {
      const files = this.storeFiles(request.files);
      request = { ...request, files: files.map(file => ({ ...file, path: relative(this.files, file.path) })) };
    }
    await guard();
    const result = JSON.parse(await this.transport.rooms(this.queue.get(id), request, this.controller.signal, guard, this.files));
    if (request.action === 'receive_attachment' && result.file) {
      const file = result.file as IncomingAttachment;
      const bytes = await readOutgoing({ path: file.path, root: dirname(file.path) }, this.maxBytes);
      await guard();
      if (typeof request.room !== 'string' || !this.transport.roomAllowed ||
          !(await this.transport.roomAllowed(this.queue.get(id), request.room))) {
        throw new WorkerError(403, 'Attachment destination access or room privacy changed.');
      }
      this.queue.checkLease(id, lease);
      return { ...result, file: { name: file.name, mimetype: file.mimetype, size: bytes.length,
        data: bytes.toString('base64'), ...(file.transcription && { transcription: file.transcription }) } };
    }
    if (request.action === 'list' || request.action === 'status') await guard();
    return result;
  }
  async deliver() {
    if (this.delivering || this.stopped) return;
    this.delivering = true;
    try {
      for (const pending of this.queue.list('replied')) {
        try {
          await this.allowed(pending);
          if (!pending.delivery) this.queue.prepare(pending.id, await diagnosticOperation({ operation: 'worker.prepare', task: pending.id, taskAttempt: pending.attempt }, () => this.transport.prepare(pending)));
          let task = this.queue.get(pending.id);
          while (task.status === 'replied' && task.delivery && task.delivery.next < task.delivery.events.length) {
            await this.allowed(task);
            // Check cancellation after asynchronous access checks, before sending.
            if (this.queue.get(task.id).status !== 'replied') break;
            const eventId = await diagnosticOperation({ operation: 'worker.send', task: task.id, taskAttempt: task.attempt }, () => this.transport.send(task, this.queue.transaction(task.id, task.delivery!.next), task.delivery!.events[task.delivery!.next]));
            this.queue.deliveredPart(task.id); task = this.queue.get(task.id);
            if (task.status === 'delivered' && eventId && this.transport.completed) {
              // Delivery is already durable; a reaction failure must not resend it.
              await this.allowed(task);
              await diagnosticOperation({ operation: 'worker.completed', task: task.id, taskAttempt: task.attempt }, () => this.transport.completed!(task, eventId));
            }
          }
        } catch (error) { this.transport.report(error); }
      }
    } catch (error) { this.transport.report(error); }
    finally { this.delivering = false; }
  }
}
