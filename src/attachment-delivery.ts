import { deliveryId, type ScopedReceipts } from './delivery-receipts.js';
import { basename, relative } from 'node:path';
import { PublicError, errorMessage } from './errors.js';
import { outgoingAttachments, hashOutgoing, safeName, validateOutgoing, type BackendReply, type OutgoingAttachment } from './media.js';

export type SendAttachments = (files: OutgoingAttachment[], signal: AbortSignal) => Promise<void>;
type Receipt = { path: string; name: string; status: 'sent' | 'uncertain' | 'not_sent'; error?: string };

// Turn-local attempts suppress final-manifest repeats. When configured, the
// durable receipt store also prevents replay across turns and restarts.
export function attachmentDelivery(root: string, maxBytes: number, send: SendAttachments, receipts?: () => ScopedReceipts | Promise<ScopedReceipts>) {
  const attempted = new Map<string, Receipt>();
  const fingerprints = new Map<string, string>();
  let busy = false;
  const deliver = async (input: unknown, signal: AbortSignal): Promise<string> => {
      signal.throwIfAborted();
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'files')) {
        throw new PublicError('Supply only files; the destination is the current conversation.');
      }
      const files = outgoingAttachments(input, root);
      if (!files.length) throw new PublicError('Supply at least one attachment.');
      if ((input as { files: object[] }).files.some(file => Object.keys(file).some(k => k !== 'path' && k !== 'name'))) {
        throw new PublicError('Each attachment accepts only path and optional name.');
      }
      if (busy) throw new PublicError('An attachment delivery is already pending.');
      busy = true;
      try {
        // Reject the whole batch before sending anything if a new file is invalid.
        for (const file of files) if (!attempted.has(file.path)) await validateOutgoing(file, maxBytes);
        const receipts: Receipt[] = [];
        let stopped = false;
        for (const file of files) {
          const previous = attempted.get(file.path);
          if (previous) { receipts.push({ ...previous }); continue; }
          const receipt: Receipt = { path: relative(root, file.path), name: safeName(file.name || basename(file.path)), status: 'not_sent' };
          if (stopped || signal.aborted) { receipts.push(receipt); continue; }
          // Delivery may succeed even if its acknowledgement is lost. Never retry
          // this path automatically after entering the transport.
          receipt.status = 'uncertain';
          attempted.set(file.path, receipt);
          try {
            await send([file], signal);
            receipt.status = 'sent';
          } catch (error) {
            receipt.error = errorMessage(error, 'Delivery failed; inspect the conversation before retrying');
            stopped = true;
          }
          receipts.push({ ...receipt });
        }
        return JSON.stringify({ files: receipts });
      } finally { busy = false; }
  };
  return {
    async action(input: unknown, signal: AbortSignal): Promise<string> {
      signal.throwIfAborted();
      const store = await receipts?.();
      if (!store) return deliver(input, signal);
      const request = input as { action?: string; id?: string; files?: unknown } | undefined;
      if (request?.action === 'status' && Object.keys(request).every(k => ['action', 'id'].includes(k))) return store.read(request.id);
      if (!request || !deliveryId(request.id) || Object.keys(request).some(k => !['id', 'files'].includes(k))) throw new PublicError('Supply id and files, or action=status with optional id to inspect retained deliveries.');
      const files = outgoingAttachments({ files: request.files }, root);
      if (!files.length || (request.files as object[]).some(file => Object.keys(file).some(k => !['path', 'name'].includes(k)))) throw new PublicError('Supply files with path and optional name.');
      const fingerprint = await attachmentFingerprint(files, maxBytes);
      signal.throwIfAborted();
      const contents = JSON.parse(fingerprint) as object[];
      for (const [i, file] of files.entries()) if (fingerprints.has(file.path) && fingerprints.get(file.path) !== JSON.stringify(contents[i])) throw new PublicError('An attempted attachment changed during this turn. Use a new path and delivery id.');
      const result = await store.run(request.id, fingerprint, () => deliver({ files: request.files }, signal));
      // A previous turn may have sent these files. Suppress final-manifest repeats too.
      const saved = JSON.parse(result);
      for (const [i, file] of files.entries()) {
        if (saved.files?.[i]?.status === 'not_sent') continue;
        fingerprints.set(file.path, JSON.stringify(contents[i]));
        if (!attempted.has(file.path)) attempted.set(file.path, { path: relative(root, file.path), name: safeName(file.name || basename(file.path)), status: 'uncertain' });
      }
      return result;
    },
    final(reply: string | BackendReply): string | BackendReply {
      return typeof reply === 'string' ? reply : { ...reply, attachments: reply.attachments.filter(file => !attempted.has(file.path)) };
    },
  };
}

export async function attachmentFingerprint(files: OutgoingAttachment[], maxBytes: number): Promise<string> {
  const entries = [];
  for (const file of files) {
    const sha256 = await hashOutgoing(file, maxBytes);
    entries.push({ path: relative(file.root, file.path), name: safeName(file.name || basename(file.path)), sha256 });
  }
  return JSON.stringify(entries);
}
