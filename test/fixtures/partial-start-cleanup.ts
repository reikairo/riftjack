import { appendFileSync } from 'node:fs';
import { MatrixClient } from '@vector-im/matrix-bot-sdk';
import { Bridge } from '../../src/bridge.js';
import { WorkerServer } from '../../src/worker-server.js';

const record = (event: string) => appendFileSync('lifecycle', event + '\n');
const users = new Map<MatrixClient, string>();
const recovery = new Map<Bridge, ReturnType<typeof setInterval>>();
const active = new Map<MatrixClient, ReturnType<typeof setInterval>>();
MatrixClient.prototype.getWhoAmI = async function () {
  Object.defineProperty(this, 'crypto', { value: { prepare: async () => {}, isReady: false } });
  if (!users.has(this)) users.set(this, users.size === 0 ? '@failed:test' : '@healthy:test');
  return { user_id: users.get(this)!, device_id: 'test-device' };
};
Bridge.prototype.recoverMessages = async function () {
  record('recovery-start');
  recovery.set(this, setInterval(() => {}, 1000));
};
const stopBridge = Bridge.prototype.stop;
Bridge.prototype.stop = function () {
  if (recovery.has(this)) {
    clearInterval(recovery.get(this)); recovery.delete(this); record('recovery-stop');
  }
  stopBridge.call(this);
};
MatrixClient.prototype.start = async function () {
  if (users.get(this) === '@failed:test') {
    record('failed-start');
    throw Object.assign(new Error('Startup failed'), { code: 'ENETUNREACH' });
  }
  record('healthy-start'); active.set(this, setInterval(() => {}, 1000));
};
MatrixClient.prototype.stop = function () {
  record('client-stop:' + users.get(this));
  clearInterval(active.get(this)); active.delete(this);
  if (users.get(this) === '@failed:test' && process.env.TEST_STOP_FAILURE === '1') {
    throw Object.assign(new Error('Cleanup failed'), { code: 'EIO' });
  }
};
WorkerServer.prototype.start = async () => {
  record('recovery-active:' + recovery.size);
  setImmediate(() => process.kill(process.pid, 'SIGTERM'));
  return 8788;
};
WorkerServer.prototype.stop = async () => {};
globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
