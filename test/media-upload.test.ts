import { hostErrorDetails } from '../src/host-diagnostics.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { Attachment, EncryptedAttachment } from '@matrix-org/matrix-sdk-crypto-nodejs';
import { uploadEncrypted, type UploadMeasurement } from '../src/media-upload.js';
function options(fetcher: typeof fetch, overrides = {}) {
  return { homeserver: 'https://matrix.test', accessToken: 'secret-test-token', size: 0,
    timeoutMs: 1000, signal: new AbortController().signal, fetcher, ...overrides };
}
async function* chunks(data: Buffer) {
  for (let offset = 0; offset < data.length; offset += 8191) yield data.subarray(offset, offset + 8191);
}
async function consume(init?: RequestInit) {
  const parts: Buffer[] = [];
  for await (const part of init?.body as unknown as AsyncIterable<Buffer>) parts.push(part);
  return Buffer.concat(parts);
}
test('streamed v2 encryption interoperates with the native SDK across chunks and empty files', async () => {
  for (const data of [Buffer.alloc(0), randomBytes(200_003)]) {
    const records: UploadMeasurement[] = []; let uploaded: Buffer = Buffer.alloc(0);
    const file = await uploadEncrypted(chunks(data), options(async (url, init) => {
      assert.equal(String(url), 'https://matrix.test/_matrix/media/v3/upload');
      assert.equal(init?.redirect, 'error');
      assert.equal((init?.headers as Record<string, string>)['Content-Length'], String(data.length));
      uploaded = await consume(init);
      return Response.json({ content_uri: 'mxc://matrix.test/test' });
    }, { size: data.length, report: (record: UploadMeasurement) => records.push(record) }));
    assert.equal(uploaded.length, data.length);
    assert.equal(file.hashes.sha256, createHash('sha256').update(uploaded).digest('base64').replace(/=+$/, ''));
    assert.deepEqual(Buffer.from(Attachment.decrypt(new EncryptedAttachment(uploaded, JSON.stringify(file)))), data);
    assert.ok(Buffer.from(file.iv, 'base64').subarray(8).equals(Buffer.alloc(8)));
    assert.deepEqual(records.map(r => r.status), ['started', 'complete']);
    assert.equal(records[1].encryptedBytes, data.length);
    assert.ok(records[1].elapsedMs >= 0);
    assert.doesNotMatch(JSON.stringify(records), /secret-test-token|mxc:|A256CTR/);
  }
});
test('early rejection stops the source and reveals only HTTP status', async () => {
  let pulled = 0; const records: UploadMeasurement[] = [];
  async function* source() { for (let n = 0; n < 10000; n++) { pulled++; yield Buffer.alloc(1024); } }
  await assert.rejects(uploadEncrypted(source(), options(async () => new Response('private secret', { status: 413 }),
    { size: 10000 * 1024, report: (r: UploadMeasurement) => records.push(r) })), /HTTP 413/);
  assert.ok(pulled < 10000); assert.equal(records.at(-1)?.status, 'failed');
  assert.doesNotMatch(JSON.stringify(records), /private secret|secret-test-token/);
});
test('success before consuming the complete body is rejected', async () => {
  await assert.rejects(uploadEncrypted(chunks(Buffer.alloc(10)), options(async () =>
    Response.json({ content_uri: 'mxc://matrix.test/id' }), { size: 10 })), /complete file/);
});
test('cancellation and deadline stop upload readers', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController(); let consumed = 0;
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      void (async () => {
        try {
          for await (const _ of init!.body as unknown as AsyncIterable<Buffer>) {
            consumed++; if (cancel) controller.abort();
            await new Promise(resolve => setTimeout(resolve, 5));
          }
        } catch (error) { reject(error); }
      })();
    });
    await assert.rejects(uploadEncrypted(chunks(Buffer.alloc(2_000_000)), options(fetcher,
      { size: 2_000_000, signal: controller.signal, timeoutMs: 20 })), cancel ? /abort/i : /Timeout/);
    assert.ok(consumed < 245);
  }
});
test('short and growing bodies cannot produce usable metadata', async () => {
  const fetcher: typeof fetch = async (_url, init) => { await consume(init); return Response.json({ content_uri: 'mxc://matrix.test/id' }); };
  for (const size of [9, 11]) await assert.rejects(uploadEncrypted(chunks(Buffer.alloc(10)), options(fetcher, { size })), /changed/);
});
test('invalid server replies cannot leak bodies or produce metadata', async () => {
  for (const body of ['private secret', JSON.stringify({ content_uri: 'https://private.test/secret' }), 'x'.repeat(16385)]) {
    await assert.rejects(uploadEncrypted(chunks(Buffer.alloc(0)), options(async (_url, init) => {
      await consume(init); return new Response(body);
    })), error => { assert.doesNotMatch(String(error), /private secret|private.test/); return true; });
  }
});

for (const failureAt of ['network', 'source'] as const) {
  test(`upload retains the original ${failureAt} failure for owner diagnostics without retry`, async () => {
    const failure = Object.assign(new Error('private upload failure details'), { code: 'ECONNRESET' });
    let requests = 0;
    const records: UploadMeasurement[] = [];
    async function* source() {
      if (failureAt === 'source') throw failure;
      yield Buffer.alloc(1);
    }
    await assert.rejects(uploadEncrypted(source(), options(async (_url, init) => {
      requests++;
      if (failureAt === 'network') throw failure;
      await consume(init);
      return Response.json({ content_uri: 'mxc://matrix.test/id' });
    }, { size: 1, report: (record: UploadMeasurement) => records.push(record) })), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, failure);
      assert.doesNotMatch(error.message, /private upload failure details/);
      assert.match(JSON.stringify(hostErrorDetails(error)), /private upload failure details/);
      return true;
    });
    assert.equal(requests, 1);
    assert.deepEqual(records.map(record => record.status), ['started', 'failed']);
    assert.doesNotMatch(JSON.stringify(records), /private upload failure details/);
  });
}

test('malformed upload response retains its parse cause separately from the public summary', async () => {
  await assert.rejects(uploadEncrypted(chunks(Buffer.alloc(0)), options(async (_url, init) => {
    await consume(init);
    return new Response('private invalid response');
  })), error => {
    assert.ok(error instanceof Error);
    assert.ok(error.cause instanceof SyntaxError);
    assert.doesNotMatch(error.message, /private invalid response/);
    assert.ok(hostErrorDetails(error).nodes.some(node => node.name === 'SyntaxError'));
    return true;
  });
});

test('upload preserves the exact caller cancellation reason', async () => {
  const controller = new AbortController(), reason = new Error('caller cancelled');
  await assert.rejects(uploadEncrypted(chunks(Buffer.alloc(0)), options(async () => {
    controller.abort(reason); throw reason;
  }, { signal: controller.signal })), error => error === reason);
});
