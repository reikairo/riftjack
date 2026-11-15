import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provision } from '../src/accounts.js';
import { loadConfig } from '../src/config.js';
import { errorMessage, PublicError } from '../src/errors.js';
import { hostErrorDetails } from '../src/host-diagnostics.js';

for (const stage of ['request', 'body', 'json'] as const) {
  test(`bot provisioning retains the original ${stage} failure for owner diagnostics`, async () => {
    const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.example', MATRIX_OWNER_ID: '@owner:example',
      RIFTJACK_WORKSPACE: process.cwd(), SYNAPSE_ADMIN_TOKEN: 'test-admin' });
    const failure = stage === 'json' ? new SyntaxError('private-response-fragment')
      : new TypeError('private-provider-details', { cause: Object.assign(new Error('private-network-details'), { code: 'ECONNRESET' }) });
    const fetcher = (async () => {
      if (stage === 'request') throw failure;
      const response = Response.json({});
      response.json = async () => { throw failure; };
      return response;
    }) as typeof fetch;
    await assert.rejects(provision(config, 'codex', 'Builder', undefined, fetcher), error => {
      assert.ok(error instanceof PublicError);
      assert.doesNotMatch(errorMessage(error), /private-/);
      assert.equal(error.cause, failure);
      assert.ok(hostErrorDetails(error).nodes.some(node => node.message === failure.message && node.stack === failure.stack));
      return true;
    });
  });
}
