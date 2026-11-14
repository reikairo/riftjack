import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostDiagnosticLog, hostErrorDetails } from '../src/host-diagnostics.js';
import { configureHostDiagnostics, diagnosticRecord, reportDiagnostic } from '../src/diagnostics.js';
import { errorMessage } from '../src/errors.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'host-diagnostics-'));
  t.after(() => { configureHostDiagnostics(undefined); rmSync(root, { recursive: true, force: true }); });
  const directory = join(root, 'diagnostics');
  return { directory, path: join(directory, 'errors.jsonl') };
}

test('host journal retains original causes and dependency stacks while summaries stay bounded', t => {
  const f = fixture(t), output: string[] = [];
  t.mock.method(console, 'error', (line: string) => output.push(line));
  configureHostDiagnostics(f.directory);
  const cause = Object.assign(new Error('Original provider explanation'), { code: 'PROVIDER_CUSTOM_CODE' });
  cause.stack = 'Error: Original provider explanation\n    at decode (/dependency/module.js:32:4)';
  const error = new AggregateError([cause], 'Original wrapper explanation', { cause });
  reportDiagnostic(error, { operation: 'worker.send', bot: '@bot:example.com' });
  const record = JSON.parse(readFileSync(f.path, 'utf8'));
  assert.equal(record.ownerContext.bot, '@bot:example.com');
  assert.equal(record.errorDetails.nodes[0].message, error.message);
  assert.equal(record.errorDetails.nodes[1].stack, cause.stack);
  assert.equal(record.errorDetails.nodes[1].code, 'PROVIDER_CUSTOM_CODE');
  assert.deepEqual(record.errorDetails.nodes[0].errors, [record.errorDetails.nodes[0].cause]);
  assert.doesNotMatch(output.join(''), /Original|dependency|PROVIDER_CUSTOM_CODE|@bot/);
  assert.doesNotMatch(errorMessage(error), /Original|dependency/);
  assert.doesNotMatch(JSON.stringify(diagnosticRecord(error, { operation: 'worker.send' })), /Original|dependency/);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
});

test('host details handle cycles, inaccessible properties, thrown strings and oversized chains', () => {
  const error = new Error('first'); error.cause = error;
  assert.deepEqual(hostErrorDetails(error).nodes[0].cause, { ref: 0 });
  assert.deepEqual(hostErrorDetails('thrown text').root, { thrown: 'thrown text' });
  assert.equal(hostErrorDetails({ get message() { throw new Error('getter'); } }).nodes[0].unreadable, true);
  let chain: Error = new Error('x'.repeat(20_000));
  for (let i = 0; i < 30; i++) chain = new Error('wrapper', { cause: chain });
  const details = hostErrorDetails(chain);
  assert.equal(details.nodes.length, 16); assert.equal(details.truncated, true);
  assert.equal(hostErrorDetails(new Error('x'.repeat(20_000))).truncated, true);
});

test('journal rotates one private backup and bounds oversized records', t => {
  const f = fixture(t), log = new HostDiagnosticLog(f.directory, 1024);
  for (let i = 0; i < 10; i++) log.write({ message: 'original '.repeat(15) }, { sequence: i });
  assert.ok(statSync(f.path).size <= 1024);
  assert.ok(statSync(f.path + '.1').size <= 1024);
  assert.equal(statSync(f.path + '.1').mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(f.path, 'utf8').trim().split('\n').at(-1)!).sequence, 9);
  log.write(new Error('x'.repeat(20_000)), { sequence: 10 });
  const last = JSON.parse(readFileSync(f.path, 'utf8').trim().split('\n').at(-1)!);
  assert.equal(last.errorDetails.truncated, true);
  assert.equal(last.errorDetails.reason, 'record-size-limit');
});

test('broken console does not prevent the host journal from retaining an error', t => {
  const f = fixture(t);
  configureHostDiagnostics(f.directory);
  t.mock.method(console, 'error', () => { throw new Error('console unavailable'); });
  assert.doesNotThrow(() => reportDiagnostic(new Error('original'), { operation: 'worker.send' }));
  assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).errorDetails.nodes[0].message, 'original');
});

test('journal failures retain console summaries, report once, and retry after storage recovers', t => {
  const f = fixture(t), output: string[] = [];
  writeFileSync(f.directory, 'blocks directory creation');
  configureHostDiagnostics(f.directory);
  t.mock.method(console, 'error', (line: string) => output.push(line));
  for (let i = 0; i < 2; i++) assert.doesNotThrow(() => reportDiagnostic(new Error('original'), { operation: 'worker.send' }));
  assert.equal(output.filter(line => JSON.parse(line).operation === 'diagnostics.write').length, 1);
  assert.equal(output.filter(line => JSON.parse(line).operation === 'worker.send').length, 2);
  rmSync(f.directory);
  reportDiagnostic(new Error('recovered'), { operation: 'worker.send' });
  assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).errorDetails.nodes[0].message, 'recovered');
});
