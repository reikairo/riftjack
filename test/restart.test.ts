import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_EXIT_CODE, RestartController, RESTART_EXIT_CODE, SUPERVISOR_RESTART_EXIT_CODE } from '../src/restart.js';
import { CodeHistory } from '../src/history.js';
import { supervise, supervisorCodeHash } from '../src/supervisor.js';
import { RestartNotice, type RestartTarget } from '../src/restart-notice.js';

const target: RestartTarget = { botId: '@bot:test', roomId: '!original:test', sender: '@owner:test', eventId: '$restart', threadId: '$thread' };

function directory(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('restart reserves globally, acknowledges first, and exits with the supervisor restart code', async () => {
  let release!: () => void;
  const acknowledgement = new Promise<void>(resolve => { release = resolve; });
  const exits: number[] = [];
  const restart = new RestartController({ supported: true, busy: () => false, shutdown: code => exits.push(code) });
  const pending = restart.request(async text => { assert.match(text, /Conversations and files will be preserved/); await acknowledgement; });
  assert.equal(restart.pending, true); assert.deepEqual(exits, []);
  await assert.rejects(restart.request(async () => {}), /already restarting/);
  release(); await pending;
  assert.deepEqual(exits, [RESTART_EXIT_CODE]);
});

test('failed acknowledgement releases the restart reservation without stopping the connector', async () => {
  const exits: number[] = [];
  const restart = new RestartController({ supported: true, busy: () => false, shutdown: code => exits.push(code) });
  await assert.rejects(restart.request(async () => { throw new Error('Matrix unavailable'); }), /Matrix unavailable/);
  assert.equal(restart.pending, false); assert.deepEqual(exits, []);
  await restart.request(async () => {});
  assert.deepEqual(exits, [RESTART_EXIT_CODE]);
});

test('explicit supervisor restart requires advertised support and acknowledges before stopping', async () => {
  const exits: number[] = [];
  const old = new RestartController({ supported: true, busy: () => false, shutdown: code => exits.push(code) });
  await assert.rejects(old.request(async () => assert.fail('must not acknowledge'), target, 'supervisor'), /host terminal/);
  assert.equal(old.pending, false); assert.equal(exits.length, 0);
  const current = new RestartController({ supported: true, supervisorSupported: true, busy: () => false, shutdown: code => exits.push(code) });
  await current.request(async text => { assert.match(text, /supervisor, connector/); assert.deepEqual(exits, []); }, target, 'supervisor');
  assert.deepEqual(exits, [SUPERVISOR_RESTART_EXIT_CODE]);
});

test('explicit supervisor restart still refuses busy work and failed acknowledgements', async () => {
  let busy = true;
  const current = new RestartController({ supported: true, supervisorSupported: true, busy: () => busy, shutdown: () => assert.fail('must not exit') });
  await assert.rejects(current.request(async () => assert.fail('must not acknowledge'), target, 'supervisor'), /busy/);
  busy = false;
  await assert.rejects(current.request(async () => { throw new Error('offline'); }, target, 'supervisor'), /offline/);
  assert.equal(current.pending, false);
});

test('busy and unsupervised connectors reject restart without acknowledging or exiting', async () => {
  for (const [supported, busy, expected] of [[true, true, /busy/], [false, false, /npm start/]] as const) {
    const restart = new RestartController({ supported, busy: () => busy, shutdown: () => assert.fail('Unexpected exit') });
    await assert.rejects(restart.request(async () => assert.fail('Unexpected acknowledgement')), expected);
    assert.equal(restart.pending, false);
  }
});

test('restart persists its destination before acknowledgement and process shutdown', async t => {
  const file = join(directory(t), 'notice.json');
  const notice = new RestartNotice(file);
  let shutdown = false;
  const restart = new RestartController({ supported: true, busy: () => false, notice, shutdown: () => { shutdown = true; } });
  await restart.request(async () => {
    assert.deepEqual(new RestartNotice(file).read(), { ...target, transactionId: notice.read()!.transactionId });
    assert.equal(shutdown, false);
  }, target);
  assert.equal(shutdown, true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('failed acknowledgement clears the stored notification and allows retry', async t => {
  const notice = new RestartNotice(join(directory(t), 'notice.json'));
  const restart = new RestartController({ supported: true, busy: () => false, notice, shutdown: () => assert.fail('must not restart') });
  await assert.rejects(restart.request(async () => { throw new Error('offline'); }, target), /offline/);
  assert.equal(notice.read(), undefined);
  assert.equal(restart.pending, false);
});

test('failed persistence does not acknowledge or restart', async t => {
  const dir = directory(t);
  const blocker = join(dir, 'not-a-directory');
  writeFileSync(blocker, 'file');
  const notice = new RestartNotice(join(blocker, 'notice.json'));
  const restart = new RestartController({ supported: true, busy: () => false, notice, shutdown: () => assert.fail('must not restart') });
  await assert.rejects(restart.request(async () => assert.fail('must not acknowledge'), target), /Could not save/);
  assert.equal(restart.pending, false);
});

test('notification survives replacement, preserves bot/room/thread, and is cleared only after encrypted delivery', async t => {
  const file = join(directory(t), 'notice.json');
  new RestartNotice(file).save(target);
  const notice = new RestartNotice(file);
  const ciphertext = { ciphertext: 'encrypted' };
  let sends = 0;
  const options = {
    isOwner: (sender: string) => sender === target.sender,
    body: 'Connector restarted.',
    client: (botId: string) => {
      assert.equal(botId, target.botId);
      return {
        isPrivateRoom: async (room: string, sender: string) => { assert.equal(room, target.roomId); assert.equal(sender, target.sender); return true; },
        encrypt: async (room: string, content: object) => {
          assert.equal(room, target.roomId);
          assert.deepEqual(content, { msgtype: 'm.notice', body: 'Connector restarted.', 'm.relates_to': {
            rel_type: 'm.thread', event_id: target.threadId,
          } });
          return ciphertext;
        },
        send: async (room: string, transactionId: string, encrypted: unknown) => {
          assert.equal(room, target.roomId); assert.equal(transactionId, notice.read()!.transactionId);
          assert.equal(encrypted, ciphertext); sends++;
        },
      };
    },
  };
  await notice.deliver(options);
  assert.equal(notice.read(), undefined);
  await new RestartNotice(file).deliver(options);
  assert.equal(sends, 1);
});

test('uncertain delivery retains the same Matrix transaction ID for a deduplicated retry', async t => {
  const file = join(directory(t), 'notice.json');
  const notice = new RestartNotice(file);
  notice.save({ ...target, threadId: undefined });
  const transactions: string[] = [];
  const options = {
    isOwner: () => true, body: 'Started', client: () => ({
      isPrivateRoom: async () => true,
      encrypt: async (_room: string, content: object) => {
        assert.equal(Object.hasOwn(content, 'm.relates_to'), false);
        return { ciphertext: 'encrypted' };
      },
      send: async (_room: string, txn: string) => { transactions.push(txn); if (transactions.length === 1) throw new Error('response lost'); },
    }),
  };
  await assert.rejects(notice.deliver(options), /response lost/);
  assert.ok(notice.read());
  await new RestartNotice(file).deliver(options);
  assert.equal(transactions.length, 2); assert.equal(transactions[0], transactions[1]);
  assert.equal(notice.read(), undefined);
});

test('failed bot startup retains the notice without sending from another bot', async t => {
  const notice = new RestartNotice(join(directory(t), 'notice.json'));
  notice.save(target);
  await notice.deliver({ isOwner: () => true, body: 'Started', client: () => undefined });
  assert.ok(notice.read());
});

test('changed owner, room privacy, or membership during encryption prevents notification delivery', async t => {
  const notice = new RestartNotice(join(directory(t), 'notice.json'));
  for (const mode of ['owner', 'room', 'during-encryption']) {
    notice.save(target);
    let checks = 0;
    await assert.rejects(notice.deliver({
      isOwner: () => mode !== 'owner', body: 'Started', client: () => ({
        isPrivateRoom: async () => { checks++; return mode !== 'room' && !(mode === 'during-encryption' && checks === 2); },
        encrypt: async () => ({ ciphertext: 'encrypted' }),
        send: async () => assert.fail('must not send'),
      }),
    }), /withheld/);
    assert.equal(notice.read(), undefined);
  }
});

test('notification crosses a real supervisor child-process restart', async t => {
  const dir = directory(t);
  const file = join(dir, 'child.mjs');
  const controllerUrl = new URL('../src/restart.ts', import.meta.url).href;
  const noticeUrl = new URL('../src/restart-notice.ts', import.meta.url).href;
  writeFileSync(file, `
import { appendFileSync } from 'node:fs';
import { RestartController } from ${JSON.stringify(controllerUrl)};
import { RestartNotice } from ${JSON.stringify(noticeUrl)};
const notice = new RestartNotice('notice.json');
if (!notice.read()) {
  const restart = new RestartController({ supported: true, busy: () => false, notice, shutdown: code => process.exit(code) });
  await restart.request(async () => { appendFileSync('calls', 'ack\\n'); }, ${JSON.stringify(target)});
} else {
  await notice.deliver({ isOwner: () => true, body: 'Started', client: () => ({
    isPrivateRoom: async () => true, encrypt: async () => ({ ciphertext: 'encrypted' }),
    send: async (room, txn) => { appendFileSync('calls', JSON.stringify({ room, txn }) + '\\n'); },
  }) });
}
`);
  assert.equal(await supervise({ cwd: dir, args: ['--import', fileURLToPath(import.meta.resolve('tsx')), file] }), 0);
  const lines = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
  assert.equal(lines[0], 'ack'); assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).room, target.roomId);
  assert.equal(new RestartNotice(join(dir, 'notice.json')).read(), undefined);
});

test('supervisor waits for the old child to release its lock and reloads .env on restart', async t => {
  const dir = directory(t);
  writeFileSync(join(dir, '.env'), 'MATRIX_RESTART_TEST_VALUE=first\n');
  const file = join(dir, 'child.cjs');
  writeFileSync(file, `
const fs = require('node:fs');
const fd = fs.openSync('test.pid', 'wx');
fs.closeSync(fd);
process.on('exit', () => fs.unlinkSync('test.pid'));
fs.appendFileSync('calls', JSON.stringify({ value: process.env.MATRIX_RESTART_TEST_VALUE, supervised: process.env.MATRIX_CONNECTOR_SUPERVISED }) + '\\n');
if (process.env.MATRIX_RESTART_TEST_VALUE === 'first') {
  fs.writeFileSync('.env', 'MATRIX_RESTART_TEST_VALUE=second\\n');
  process.exit(${RESTART_EXIT_CODE});
}
process.exit(0);
`);
  const env = { ...process.env }; delete env.MATRIX_RESTART_TEST_VALUE;
  const code = await supervise({ cwd: dir, env, args: ['--env-file-if-exists=.env', file] });
  assert.equal(code, 0);
  assert.deepEqual(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line)), [
    { value: 'first', supervised: '1' }, { value: 'second', supervised: '1' },
  ]);
});

test('supervisor stops on normal shutdown or invalid configuration', async t => {
  const dir = directory(t);
  const file = join(dir, 'child.cjs');
  for (const exitCode of [0, CONFIG_EXIT_CODE]) {
    writeFileSync(file, `require('node:fs').appendFileSync('calls', 'called\\n'); process.exit(${exitCode});`);
    assert.equal(await supervise({ cwd: dir, args: [file] }), exitCode);
  }
  assert.equal(readFileSync(join(dir, 'calls'), 'utf8'), 'called\ncalled\n');
});

// A fake connector project: src/child.cjs is the code that gets snapshotted and rolled back.
function project(t: { after(fn: () => void): void }, source: string) {
  const root = directory(t);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'child.cjs'), source);
  writeFileSync(join(root, 'package.json'), '{}');
  const history = new CodeHistory(root, join(root, '.connector-history'));
  const run = () => supervise({ cwd: root, args: [join(root, 'src', 'child.cjs')], history, stableMs: 20, retryMs: () => 10, log: () => {} });
  const calls = () => readFileSync(join(root, 'calls'), 'utf8').trim().split('\n');
  const snapshots = (prefix: string) => existsSync(history.dir) ? readdirSync(history.dir).filter(name => name.startsWith(prefix)) : [];
  return { root, history, run, calls, snapshots };
}
// Waits until the supervisor has recorded this connector version as working.
const waitForSnapshot = `
const waitForSnapshot = async () => {
  const dir = path.join(__dirname, '..', '.connector-history');
  while (!fs.existsSync(dir) || !fs.readdirSync(dir).some(name => name.startsWith('good-'))) await new Promise(r => setTimeout(r, 5));
};`;

test('supervisor restarts crashed connectors with the same code and snapshots only working versions', async t => {
  const p = project(t, `
const fs = require('node:fs'); const path = require('node:path');${waitForSnapshot}
const run = fs.existsSync('calls') ? fs.readFileSync('calls', 'utf8').trim().split('\\n').length : 0;
fs.appendFileSync('calls', 'run' + run + '\\n');
(async () => {
  if (run === 0) process.exit(1); // crash before ready, no snapshot yet: plain retry
  if (run === 1) { process.send({ type: 'connector-ready' }); await waitForSnapshot(); process.exit(1); } // crash after proving stable
  process.exit(0);
})();
`);
  assert.equal(await p.run(), 0);
  assert.deepEqual(p.calls(), ['run0', 'run1', 'run2']);
  assert.equal(p.snapshots('good-').length, 1);
  assert.deepEqual(p.snapshots('failed-'), []);
});

test('a connector that crashes after !restart is rolled back and the requester is told', async t => {
  const broken = "require('node:fs').appendFileSync('calls', 'broken\\n'); process.exit(1);";
  const working = `
const fs = require('node:fs'); const path = require('node:path');${waitForSnapshot}
const noticeFile = path.join(__dirname, '..', 'data', 'restart-notice.json');
process.send({ type: 'connector-config', dataDir: path.join(__dirname, '..', 'data') });
(async () => {
  if (!fs.existsSync('restarted')) {
    fs.appendFileSync('calls', 'working\\n');
    process.send({ type: 'connector-ready' });
    await waitForSnapshot();
    // Simulate an update followed by !restart from the owner.
    fs.writeFileSync(__filename, ${JSON.stringify(broken)});
    fs.mkdirSync(path.dirname(noticeFile), { recursive: true });
    fs.writeFileSync(noticeFile, JSON.stringify({ ...${JSON.stringify(target)}, transactionId: 'first' }));
    fs.writeFileSync('restarted', '');
    process.exit(${RESTART_EXIT_CODE});
  }
  fs.appendFileSync('calls', 'restored ' + fs.readFileSync(noticeFile, 'utf8') + '\\n');
  process.exit(0);
})();
`;
  const p = project(t, working);
  assert.equal(await p.run(), 0);
  const calls = p.calls();
  assert.deepEqual(calls.slice(0, 2), ['working', 'broken']);
  const notice = JSON.parse(calls[2].slice('restored '.length));
  assert.equal(notice.roomId, target.roomId); assert.equal(notice.threadId, target.threadId); assert.equal(notice.eventId, target.eventId);
  assert.notEqual(notice.transactionId, 'first');
  assert.match(notice.rollback, /Automatic rollback/);
  assert.equal(readFileSync(join(p.root, 'src', 'child.cjs'), 'utf8'), working);
  const [failed] = p.snapshots('failed-');
  assert.equal(readFileSync(join(p.history.dir, failed, 'src', 'child.cjs'), 'utf8'), broken);
});

test('a rollback after an ordinary crash is addressed to the manager DM', async t => {
  const broken = "require('node:fs').appendFileSync('calls', 'broken\\n'); process.exit(1);";
  const working = `
const fs = require('node:fs'); const path = require('node:path');${waitForSnapshot}
const noticeFile = path.join(__dirname, '..', 'data', 'restart-notice.json');
process.send({ type: 'connector-config', dataDir: path.join(__dirname, '..', 'data') });
(async () => {
  if (!fs.existsSync('updated')) {
    fs.appendFileSync('calls', 'working\\n');
    process.send({ type: 'connector-ready' });
    await waitForSnapshot();
    // The code is changed on disk, then the stable connector crashes on its own.
    fs.writeFileSync(__filename, ${JSON.stringify(broken)});
    fs.writeFileSync('updated', '');
    process.exit(1);
  }
  fs.appendFileSync('calls', 'restored ' + fs.readFileSync(noticeFile, 'utf8') + '\\n');
  process.exit(0);
})();
`;
  const p = project(t, working);
  assert.equal(await p.run(), 0);
  const calls = p.calls();
  assert.deepEqual(calls.slice(0, 2), ['working', 'broken']);
  const notice = JSON.parse(calls[2].slice('restored '.length));
  assert.equal(notice.botId, undefined);
  assert.match(notice.rollback, /^Automatic rollback: the connector crashed while starting, so/);
});

test('an unrequested rollback notice is sent to the owner in the manager DM without a reply relation', async t => {
  const notice = new RestartNotice(join(directory(t), 'notice.json'));
  notice.save(undefined, 'Automatic rollback: restored.');
  const manager = { botId: '@manager:test', roomId: '!manager:test', sender: '@owner:test' };
  // Not delivered until the manager bot is online.
  await notice.deliver({ isOwner: () => true, body: 'Started', manager: () => undefined, client: () => assert.fail('no destination yet') });
  assert.ok(notice.read());
  let sent: { room: string; content: any } | undefined;
  await notice.deliver({ isOwner: sender => sender === manager.sender, body: 'Connector restarted.', manager: () => manager, client: botId => {
    assert.equal(botId, manager.botId);
    return {
      isPrivateRoom: async (room: string, sender: string) => room === manager.roomId && sender === manager.sender,
      encrypt: async (room: string, content: object) => { sent = { room, content }; return {}; },
      send: async () => {},
    };
  } });
  assert.deepEqual(sent, { room: manager.roomId, content: { msgtype: 'm.notice', body: 'Automatic rollback: restored.\n\nConnector restarted.' } });
  assert.equal(notice.read(), undefined);
});

test('rolled-back notice text is delivered ahead of the normal restart message', async t => {
  const notice = new RestartNotice(join(directory(t), 'notice.json'));
  notice.save(target, 'Automatic rollback: restored.');
  let body = '';
  await notice.deliver({ isOwner: () => true, body: 'Connector restarted.', client: () => ({
    isPrivateRoom: async () => true,
    encrypt: async (_room: string, content: object) => { body = (content as { body: string }).body; return {}; },
    send: async () => {},
  }) });
  assert.equal(body, 'Automatic rollback: restored.\n\nConnector restarted.');
});

test('code history ignores unchanged code and never rolls back to the running version', async t => {
  const p = project(t, 'v1');
  assert.equal(p.history.rollback(), undefined);
  assert.ok(p.history.promote(p.history.capture())); assert.equal(p.history.promote(p.history.capture()), undefined);
  assert.equal(p.history.rollback(), undefined);
  writeFileSync(join(p.root, 'src', 'child.cjs'), 'v2');
  assert.ok(p.history.rollback());
  assert.equal(readFileSync(join(p.root, 'src', 'child.cjs'), 'utf8'), 'v1');
});

test('!restart hands over to a fresh supervisor when the supervisor code changed', async t => {
  const dir = directory(t);
  writeFileSync(join(dir, 'child.cjs'), `require('node:fs').appendFileSync('calls', 'connector\\n'); process.exit(${RESTART_EXIT_CODE});`);
  writeFileSync(join(dir, 'next.cjs'), `require('node:fs').appendFileSync('calls', 'new supervisor\\n'); process.exit(0);`);
  let checks = 0;
  const code = await supervise({ cwd: dir, args: [join(dir, 'child.cjs')], log: () => {},
    upgrade: { changed: () => ++checks > 0, args: [join(dir, 'next.cjs')] } });
  assert.equal(code, 0); assert.equal(checks, 1);
  assert.equal(readFileSync(join(dir, 'calls'), 'utf8'), 'connector\nnew supervisor\n');
});

test('!restart supervisor replaces unchanged supervisor code after the connector has exited', async t => {
  const dir = directory(t);
  writeFileSync(join(dir, 'child.cjs'), `
const fs = require('node:fs');
if (process.env.MATRIX_CONNECTOR_SUPERVISOR_RESTART !== '1') process.exit(78);
fs.writeFileSync('lock', 'held');
process.on('exit', () => fs.unlinkSync('lock'));
fs.appendFileSync('calls', 'connector\\n');
process.exit(${SUPERVISOR_RESTART_EXIT_CODE});
`);
  writeFileSync(join(dir, 'next.cjs'), `
const fs = require('node:fs');
if (fs.existsSync('lock')) process.exit(1);
fs.appendFileSync('calls', 'fresh supervisor\\n');
`);
  const code = await supervise({ cwd: dir, args: [join(dir, 'child.cjs')], log: () => {},
    upgrade: { changed: () => false, args: [join(dir, 'next.cjs')] } });
  assert.equal(code, 0);
  assert.equal(readFileSync(join(dir, 'calls'), 'utf8'), 'connector\nfresh supervisor\n');
});

test('supervisor without replacement support overrides any inherited capability flag', async t => {
  const dir = directory(t);
  const file = join(dir, 'child.cjs');
  writeFileSync(file, `process.exit(process.env.MATRIX_CONNECTOR_SUPERVISOR_RESTART === '0' ? 0 : 78);`);
  assert.equal(await supervise({ cwd: dir, args: [file], env: { ...process.env, MATRIX_CONNECTOR_SUPERVISOR_RESTART: '1' } }), 0);
});

test('supervisor code hash changes only with supervisor modules', t => {
  const dir = directory(t);
  for (const file of ['supervisor.ts', 'restart.ts', 'restart-notice.ts', 'history.ts', 'errors.ts', 'main.ts']) writeFileSync(join(dir, file), file);
  const before = supervisorCodeHash(dir);
  writeFileSync(join(dir, 'main.ts'), 'changed');
  assert.equal(supervisorCodeHash(dir), before);
  writeFileSync(join(dir, 'history.ts'), 'changed');
  assert.notEqual(supervisorCodeHash(dir), before);
});

test('SIGTERM to the supervisor stops its child and overrides a simultaneous restart request', { timeout: 5000 }, async t => {
  const dir = directory(t);
  const childFile = join(dir, 'child.cjs');
  writeFileSync(childFile, `
const fs = require('node:fs');
fs.appendFileSync('calls', 'called\\n');
process.on('SIGTERM', () => { fs.writeFileSync('stopped', 'yes'); process.exit(${RESTART_EXIT_CODE}); });
setInterval(() => {}, 1000);
console.log('ready');
`);
  const runner = join(dir, 'runner.mjs');
  const supervisor = new URL('../src/supervisor.ts', import.meta.url).href;
  writeFileSync(runner, `import { supervise } from ${JSON.stringify(supervisor)}; process.exitCode = await supervise({ cwd: ${JSON.stringify(dir)}, args: [${JSON.stringify(childFile)}] });`);
  const processChild = spawn(process.execPath, ['--import', fileURLToPath(import.meta.resolve('tsx')), runner], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (processChild.exitCode === null) processChild.kill('SIGKILL'); });
  let errors = '';
  processChild.stderr.on('data', data => { errors += data; });
  const closed = new Promise<number | null>((resolve, reject) => { processChild.once('error', reject); processChild.once('close', resolve); });
  let ready = false;
  processChild.stdout.on('data', data => {
    if (!ready && String(data).includes('ready')) { ready = true; processChild.kill('SIGTERM'); }
  });
  assert.equal(await closed, 0, errors);
  assert.equal(ready, true);
  assert.equal(readFileSync(join(dir, 'stopped'), 'utf8'), 'yes');
  assert.equal(readFileSync(join(dir, 'calls'), 'utf8'), 'called\n');
});

test('working snapshots promote captured launch files instead of later unexecuted edits', async t => {
  const broken = "require('node:fs').appendFileSync('calls', 'broken\\n'); process.exit(1);";
  const working = `
const fs = require('node:fs'); const path = require('node:path');${waitForSnapshot}
(async () => {
  if (fs.existsSync('edited')) { fs.appendFileSync('calls', 'restored\\n'); process.exit(0); }
  fs.appendFileSync('calls', 'working\\n');
  process.send({ type: 'connector-ready' });
  await waitForSnapshot();
  process.exit(${RESTART_EXIT_CODE});
})();
`;
  const p = project(t, working);
  // Change the working tree exactly at the end of the grace period, immediately
  // before saving. This code has not been executed by the still-running child.
  const promote = p.history.promote.bind(p.history);
  p.history.promote = snapshot => {
    writeFileSync(join(p.root, 'src', 'child.cjs'), broken);
    writeFileSync(join(p.root, 'edited'), '');
    return promote(snapshot);
  };
  assert.equal(await p.run(), 0);
  assert.deepEqual(p.calls(), ['working', 'broken', 'restored']);
  assert.equal(readFileSync(join(p.history.latest()!.path, 'src', 'child.cjs'), 'utf8'), working);
  assert.equal(readFileSync(join(p.root, 'src', 'child.cjs'), 'utf8'), working);
  assert.equal(p.snapshots('good-').length, 1);
  assert.equal(p.snapshots('failed-').length, 1);
  assert.deepEqual(p.snapshots('pending-'), []);
});

test('changes during startup prevent certification and pending snapshots are discarded', async t => {
  const p = project(t, `
const fs = require('node:fs');
fs.writeFileSync(__filename, 'unexecuted change');
process.send({ type: 'connector-ready' });
setTimeout(() => process.exit(0), 100);
`);
  assert.equal(await p.run(), 0);
  assert.equal(p.history.latest(), undefined);
  assert.deepEqual(p.snapshots('pending-'), []);
});

test('a modified launch snapshot cannot become a rollback target', t => {
  const p = project(t, 'original');
  const candidate = p.history.capture();
  assert.equal(p.history.latest(), undefined);
  writeFileSync(join(candidate.path, 'src', 'child.cjs'), 'corrupted');
  assert.throws(() => p.history.promote(candidate), /Launch snapshot changed/);
  assert.equal(p.history.latest(), undefined);
  p.history.discard(candidate);
  assert.deepEqual(p.snapshots('pending-'), []);
});


test('rollback restores scripts with source and detects script-only changes', t => {
  const p = project(t, 'source v1');
  mkdirSync(join(p.root, 'scripts'));
  const script = join(p.root, 'scripts', 'helper.mjs');
  writeFileSync(script, 'helper v1');
  p.history.promote(p.history.capture());
  const hash = p.history.hash();
  writeFileSync(script, 'helper v2');
  assert.notEqual(p.history.hash(), hash);
  assert.ok(p.history.rollback());
  assert.equal(readFileSync(script, 'utf8'), 'helper v1');
  writeFileSync(script, 'helper v3');
  writeFileSync(join(p.root, 'src', 'child.cjs'), 'source v3');
  assert.ok(p.history.rollback());
  assert.equal(readFileSync(script, 'utf8'), 'helper v1');
  assert.equal(readFileSync(join(p.root, 'src', 'child.cjs'), 'utf8'), 'source v1');
});

test('rollback rejects incomplete snapshots and incompatible installed dependencies before modifying code', t => {
  const p = project(t, 'source v1');
  writeFileSync(join(p.root, 'package-lock.json'), 'lock v1');
  p.history.promote(p.history.capture());
  const good = p.history.latest()!;
  writeFileSync(join(p.root, 'src', 'child.cjs'), 'source v2');
  writeFileSync(join(good.path, 'src', 'child.cjs'), 'corrupt');
  assert.throws(() => p.history.rollback(), /snapshot/);
  assert.equal(readFileSync(join(p.root, 'src', 'child.cjs'), 'utf8'), 'source v2');
  writeFileSync(join(good.path, 'src', 'child.cjs'), 'source v1');
  mkdirSync(join(p.root, 'node_modules'));
  writeFileSync(join(p.root, 'package-lock.json'), 'lock v2');
  assert.throws(() => p.history.rollback(), /dependency installation/);
  assert.equal(readFileSync(join(p.root, 'src', 'child.cjs'), 'utf8'), 'source v2');
});
