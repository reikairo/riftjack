import { appendFileSync } from 'node:fs';
import { MatrixClient } from '@vector-im/matrix-bot-sdk';
import { Bridge } from '../../src/bridge.js';
import { WorkerServer } from '../../src/worker-server.js';

const record = (event: string) => appendFileSync('lifecycle', event + '\n');
const failure = process.env.TEST_STOP_FAILURE;
const active = new Map<MatrixClient, ReturnType<typeof setInterval>>();
const users = new Map<MatrixClient, string>();
MatrixClient.prototype.getWhoAmI = async function () {
  Object.defineProperty(this, 'crypto', { value: { prepare: async () => {}, isReady: false } });
  if (!users.has(this)) users.set(this, users.size === 0 ? '@one:test' : '@two:test');
  return { user_id: users.get(this)!, device_id: 'test-device' };
};
MatrixClient.prototype.start = async function () {
  active.set(this, setInterval(() => {}, 1000));
};
MatrixClient.prototype.stop = function () {
  record('client-stop');
  clearInterval(active.get(this)); active.delete(this);
  if (failure === 'client') throw Object.assign(new Error('Client stop failed'), { code: 'EIO' });
};
const stopBridge = Bridge.prototype.stop;
Bridge.prototype.stop = function () {
  record('bridge-stop'); stopBridge.call(this);
  if (failure === 'bridge') throw Object.assign(new Error('Bridge stop failed'), { code: 'EIO' });
};
WorkerServer.prototype.start = async () => {
  // Trigger the normal shutdown path only after both bots are registered.
  setImmediate(() => process.kill(process.pid, 'SIGTERM'));
  return 8788;
};
WorkerServer.prototype.stop = async () => {
  record('worker-stop');
  if (failure === 'worker') throw Object.assign(new Error('Worker stop failed'), { code: 'EIO' });
};
globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
