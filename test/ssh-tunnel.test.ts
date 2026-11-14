import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { loadTunnelConfig, SshTunnel, tunnelArguments, type TunnelConfig, type TunnelDiagnostic } from '../src/ssh-tunnel.js';

const config: TunnelConfig = { target: 'user@server.example', port: 2222, localPort: 18008, remotePort: 8008 };

function fake(t: { after(fn: () => void | Promise<void>): void }, body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-ssh-'));
  const executable = join(dir, 'ssh');
  const log = join(dir, 'calls');
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const log = ${JSON.stringify(log)};
const dir = ${JSON.stringify(dir)};
${body}
`, { mode: 0o700 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const messages: string[] = [];
  const records: TunnelDiagnostic[] = [];
  const tunnel = new SshTunnel(config, { executable, retryMs: 50, killMs: 100, report: message => messages.push(message),
    diagnostic: record => records.push(record) });
  t.after(() => tunnel.stop());
  return { tunnel, messages, records, log, dir, executable };
}

const ready = `console.error('debug1: Local forwarding listening on 127.0.0.1 port 18008.');
console.error('debug1: Entering interactive session.');`;
const hold = `setInterval(() => {}, 1000);`;

test('automatic tunnelling is opt-in and restricted to an explicit loopback admin port', () => {
  const url = new URL('http://127.0.0.1:18008');
  assert.equal(loadTunnelConfig({}, url), undefined);
  assert.deepEqual(loadTunnelConfig({ SYNAPSE_SSH_TARGET: 'admin@host', SYNAPSE_SSH_PORT: '2222' }, url),
    { ...config, target: 'admin@host', identity: undefined });
  for (const target of ['-Fconfig', 'user@host -oProxyCommand=bad', '$(bad)', 'host;bad']) {
    assert.throws(() => loadTunnelConfig({ SYNAPSE_SSH_TARGET: target }, url), /SSH host alias/);
  }
  for (const value of ['https://matrix.example', 'http://0.0.0.0:18008', 'http://127.0.0.1', 'http://127.0.0.1:18008/path']) {
    assert.throws(() => loadTunnelConfig({ SYNAPSE_SSH_TARGET: 'host' }, new URL(value)), /Automatic SSH/);
  }
  for (const value of ['0', '65536', 'bad']) assert.throws(() => loadTunnelConfig({ SYNAPSE_SSH_TARGET: 'host', SYNAPSE_SSH_PORT: value }, url), /port between/);
});

test('SSH forwards only loopback and requires noninteractive verified authentication', () => {
  const args = tunnelArguments({ ...config, identity: '/path with spaces/key' });
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ExitOnForwardFailure=yes',
    'ServerAliveInterval=15', 'ServerAliveCountMax=3', 'ControlPath=none', 'ForkAfterAuthentication=no', 'ForwardAgent=no']) assert.ok(args.includes(option));
  assert.equal(args[args.indexOf('-L') + 1], '127.0.0.1:18008:127.0.0.1:8008');
  assert.equal(args[args.indexOf('-i') + 1], '/path with spaces/key');
  assert.equal(args.at(-1), config.target);
  assert.ok(!args.includes('-f') && !args.includes('-g'));
});

test('tunnel starts once, excludes connector secrets, and closes before stop resolves', async t => {
  const f = fake(t, `
fs.appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), secretKeys: Object.keys(process.env).filter(k => /TOKEN|SECRET|API_KEY|PASSWORD/.test(k)) }) + '\\n');
process.on('SIGTERM', () => { fs.writeFileSync(dir + '/stopped', 'yes'); process.exit(0); });
${ready}
${hold}`);
  f.tunnel.start(); f.tunnel.start();
  await f.tunnel.waitUntilReady(undefined, 3000);
  const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, tunnelArguments(config));
  assert.deepEqual(calls[0].secretKeys, []);
  await f.tunnel.stop();
  assert.equal(readFileSync(join(f.dir, 'stopped'), 'utf8'), 'yes');
  await delay(100);
  assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
});

test('dropped SSH process reconnects without overlapping the previous process', async t => {
  const f = fake(t, `
const lock = dir + '/lock';
fs.closeSync(fs.openSync(lock, 'wx'));
process.on('exit', () => fs.unlinkSync(lock));
process.on('SIGTERM', () => process.exit(0));
const count = fs.existsSync(log) ? Number(fs.readFileSync(log, 'utf8')) + 1 : 1;
fs.writeFileSync(log, String(count));
${ready}
if (count === 1) setTimeout(() => process.exit(255), 150);
${hold}`);
  f.tunnel.start();
  await f.tunnel.waitUntilReady(undefined, 3000);
  const deadline = Date.now() + 3000;
  while ((!existsSync(f.log) || Number(readFileSync(f.log, 'utf8')) < 2) && Date.now() < deadline) await delay(20);
  assert.equal(readFileSync(f.log, 'utf8'), '2');
  await f.tunnel.waitUntilReady(undefined, 3000);
  assert.ok(f.messages.some(message => /Reconnecting/.test(message)));
  assert.deepEqual(f.records.map(record => [record.state, record.attempt]), [['ready', 1], ['closed', 1], ['ready', 2]]);
  assert.equal(f.records[1].error, 'exit 255');
  assert.equal(f.records[1].retryMs, 50);
  assert.ok(f.records[1].elapsedMs >= 0);
  assert.doesNotMatch(JSON.stringify(f.records), /user@|server.example|private-key/);
  await f.tunnel.stop();
  assert.equal(existsSync(join(f.dir, 'lock')), false);
});

for (const [stderr, expected] of [
  ['Permission denied (publickey). secret-token', /authentication failed/],
  ['Host key verification failed. private-key-path', /host key verification failed/],
  ['bind: Address already in use private-detail', /port is already in use/],
] as const) test('SSH failure is actionable and sanitized: ' + expected, async t => {
  const f = fake(t, `console.error(${JSON.stringify(stderr)}); process.exit(255);`);
  f.tunnel.start();
  const deadline = Date.now() + 3000;
  while (!f.messages.length && Date.now() < deadline) await delay(20);
  assert.ok(f.messages.length > 0);
  await assert.rejects(f.tunnel.waitUntilReady(undefined, 0), expected);
  assert.doesNotMatch(f.messages.join('\n'), /secret-token|private-key-path|private-detail/);
  assert.doesNotMatch(JSON.stringify(f.records), /secret-token|private-key-path|private-detail/);
});

for (const [stderr, reason] of [
  ['Timeout, server private.example not responding.', 'keepalive-timeout'],
  ['client_loop: send disconnect: Broken pipe private-detail', 'broken-pipe'],
  ['Connection reset by private.example port 22', 'remote-closed'],
] as const) test('SSH close diagnostics identify ' + reason + ' without raw stderr', async t => {
  const f = fake(t, `console.error(${JSON.stringify(stderr)}); process.exit(255);`);
  f.tunnel.start();
  const deadline = Date.now() + 3000;
  while (!f.records.length && Date.now() < deadline) await delay(20);
  assert.equal(f.records[0]?.reason, reason);
  assert.equal(f.records[0]?.error, 'exit 255');
  assert.doesNotMatch(JSON.stringify(f.records), /private|port 22/);
});

test('missing ssh executable retries and stops cleanly', async () => {
  const messages: string[] = [];
  const records: TunnelDiagnostic[] = [];
  const tunnel = new SshTunnel(config, { executable: '/nonexistent/matrix-ssh', report: message => messages.push(message),
    diagnostic: record => { records.push(record); throw new Error('Observer failed'); }, retryMs: 20 });
  tunnel.start();
  try { await assert.rejects(tunnel.waitUntilReady(undefined, 100), /Could not launch OpenSSH/); }
  finally { await tunnel.stop(); }
  assert.ok(messages.length > 0);
  assert.equal(records[0].reason, 'spawn');
  assert.match(records[0].error!, /ENOENT/);
  assert.doesNotMatch(JSON.stringify(records), /nonexistent/);
});

test('cancelling readiness does not stop the shared tunnel; shutdown escalates an unresponsive child', async t => {
  const f = fake(t, `fs.writeFileSync(log, 'started'); process.on('SIGTERM', () => {}); ${hold}`);
  f.tunnel.start();
  const controller = new AbortController();
  const waiting = f.tunnel.waitUntilReady(controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  const deadline = Date.now() + 3000;
  while (!existsSync(f.log) && Date.now() < deadline) await delay(20);
  assert.ok(existsSync(f.log));
  await f.tunnel.stop();
  await assert.rejects(f.tunnel.waitUntilReady(undefined, 10), /not ready/);
});
