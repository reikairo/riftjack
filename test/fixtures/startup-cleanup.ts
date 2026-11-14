import { appendFileSync } from 'node:fs';
import { MatrixClient } from '@vector-im/matrix-bot-sdk';
import { Bridge } from '../../src/bridge.js';
import { WorkerServer } from '../../src/worker-server.js';

const record = (event: string) => appendFileSync('lifecycle', event + '\n');
const active = new Map<MatrixClient, ReturnType<typeof setInterval>>();
MatrixClient.prototype.getWhoAmI = async function () {
  // No crypto database or homeserver is used by this lifecycle fixture.
  Object.defineProperty(this, 'crypto', { value: { prepare: async () => {}, isReady: false } });
  return { user_id: '@manager:test', device_id: 'test-device' };
};
MatrixClient.prototype.start = async function () {
  record('client-start');
  active.set(this, setInterval(() => {}, 1000));
};
MatrixClient.prototype.stop = function () {
  record('client-stop');
  clearInterval(active.get(this));
  active.delete(this);
};
const stopBridge = Bridge.prototype.stop;
Bridge.prototype.stop = function () { record('bridge-stop'); stopBridge.call(this); };
WorkerServer.prototype.start = async () => {
  record('listener-failure');
  throw Object.assign(new Error('Worker listener is occupied'), { code: 'EADDRINUSE' });
};
WorkerServer.prototype.stop = async () => { record('worker-stop'); };
globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
