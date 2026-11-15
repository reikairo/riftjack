import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { EncryptedFile } from '@vector-im/matrix-bot-sdk';
import { PublicError, safeErrorSummary } from './errors.js';

export type UploadMeasurement = {
  event: 'media-upload'; id: string; status: 'started' | 'complete' | 'failed';
  bytes: number; encryptedBytes: number; elapsedMs: number; diagnostic?: string;
};
type Options = {
  homeserver: string; accessToken: string; size: number; timeoutMs: number;
  signal: AbortSignal; fetcher: typeof fetch; report?: (measurement: UploadMeasurement) => void;
};

// Matrix encrypted attachments v2: AES-256-CTR, a random 64-bit nonce followed
// by a zero 64-bit counter, and SHA-256 of the ciphertext. Key material is only
// returned for the encrypted room event; the media endpoint receives ciphertext.
export async function uploadEncrypted(chunks: AsyncIterable<Buffer>, options: Options): Promise<EncryptedFile> {
  const o = options;
  o.signal.throwIfAborted();
  const id = randomUUID(), started = performance.now();
  const stop = new AbortController();
  const signal = AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs), stop.signal]);
  const key = randomBytes(32), iv = Buffer.concat([randomBytes(8), Buffer.alloc(8)]);
  const cipher = createCipheriv('aes-256-ctr', key, iv), hash = createHash('sha256');
  let encryptedBytes = 0, consumed = false;
  const report = (status: UploadMeasurement['status'], diagnostic?: string) => {
    try { o.report?.({ event: 'media-upload', id, status, bytes: o.size, encryptedBytes,
      elapsedMs: Math.round(performance.now() - started), ...(diagnostic ? { diagnostic } : {}) }); }
    catch { /* Diagnostics must not change delivery behavior. */ }
  };
  const body = Readable.from((async function* () {
    for await (const chunk of chunks) {
      signal.throwIfAborted();
      const encrypted = cipher.update(chunk);
      encryptedBytes += encrypted.length;
      if (encryptedBytes > o.size) throw new PublicError('Attachment changed during upload.');
      hash.update(encrypted);
      yield encrypted;
    }
    const final = cipher.final();
    encryptedBytes += final.length;
    if (encryptedBytes !== o.size) throw new PublicError('Attachment changed during upload.');
    hash.update(final);
    if (final.length) yield final;
    consumed = true;
  })(), { objectMode: false, highWaterMark: 64 * 1024 });
  // Observe errors immediately, including when the server rejects a request before
  // it starts consuming the body. Always wait for the reader to close before return.
  const closed = finished(body).catch(() => {});
  const abort = () => body.destroy(signal.reason instanceof Error ? signal.reason : new Error('Upload cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  report('started');
  try {
    signal.throwIfAborted();
    const request: RequestInit & { duplex: 'half' } = {
      method: 'POST', redirect: 'error', signal, duplex: 'half', body: body as unknown as BodyInit,
      headers: { Authorization: `Bearer ${o.accessToken}`, 'Content-Type': 'application/octet-stream',
        'Content-Length': String(o.size) },
    };
    const response = await o.fetcher(o.homeserver.replace(/\/$/, '') + '/_matrix/media/v3/upload', request);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new PublicError(`Attachment upload failed: HTTP ${response.status}.`);
    }
    // A proxy can return an early success without accepting the complete file.
    if (!consumed) {
      await response.body?.cancel().catch(() => {});
      throw new PublicError('Attachment upload ended before the complete file was read.');
    }
    let text = '';
    if (!response.body) throw new PublicError('Attachment upload returned an empty response.');
    const reader = response.body.getReader();
    try {
      const buffers: Uint8Array[] = []; let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > 16 * 1024) throw new PublicError('Attachment upload returned an oversized response.');
        buffers.push(value);
      }
      text = Buffer.concat(buffers).toString('utf8');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let url: unknown;
    try { url = JSON.parse(text).content_uri; }
    catch (error) {
      throw new PublicError('Attachment upload returned an invalid media URI.', { cause: error });
    }
    if (typeof url !== 'string' || !/^mxc:\/\/[^/?#\s]+\/[^/?#\s]+$/.test(url)) {
      throw new PublicError('Attachment upload returned an invalid media URI.');
    }
    signal.throwIfAborted();
    report('complete');
    return { url, v: 'v2', key: { kty: 'oct', alg: 'A256CTR', ext: true,
      key_ops: ['encrypt', 'decrypt'], k: key.toString('base64url') },
      iv: iv.toString('base64').replace(/=+$/, ''), hashes: { sha256: hash.digest('base64').replace(/=+$/, '') } };
  } catch (error) {
    const cause = signal.aborted ? signal.reason : error;
    const diagnostic = cause instanceof PublicError ? cause.message : safeErrorSummary(cause);
    report('failed', diagnostic);
    o.signal.throwIfAborted();
    throw cause instanceof PublicError ? cause : new PublicError(`Attachment upload failed: ${diagnostic}.`, { cause });
  } finally {
    signal.removeEventListener('abort', abort);
    stop.abort();
    body.destroy();
    await closed;
  }
}
