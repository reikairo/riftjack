import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts, type Account } from '../src/accounts.js';

for (const stage of ['write', 'rename'] as const) {
  for (const operation of ['add', 'name', 'room', 'settings'] as const) {
    test(`failed account ${operation} at ${stage} does not leak into later saves`, t => {
      const root = mkdtempSync(join(tmpdir(), 'account-persistence-')), file = join(root, 'accounts.json');
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const accounts = new Accounts(file);
      const original: Account = { userId: '@bot:example.com', accessToken: 'test-token', kind: 'codex', name: 'Original' };
      const added: Account = { userId: '@new:example.com', accessToken: 'another-test-token', kind: 'claude', name: 'New' };
      accounts.add(original);
      const expected = accounts.list();
      const change = () => {
        if (operation === 'add') accounts.add(added);
        else if (operation === 'name') accounts.setName(original.userId, 'Changed');
        else if (operation === 'room') accounts.setRoom(original.userId, '!new:example.com');
        else accounts.setEngineSettings(original.userId, { model: 'test-model' });
      };
      if (stage === 'write') mkdirSync(file + '.tmp');
      else { renameSync(file, file + '.backup'); mkdirSync(file); }
      assert.throws(change, error => !!(error as NodeJS.ErrnoException).code);
      if (stage === 'write') rmSync(file + '.tmp', { recursive: true });
      else { rmSync(file, { recursive: true }); renameSync(file + '.backup', file); }
      const afterFailure = accounts.list();
      accounts.add({ userId: '@other:example.com', accessToken: 'other-test-token', kind: 'manager', name: 'Other' });
      assert.deepEqual(new Accounts(file).list().filter(a => a.userId !== '@other:example.com'), expected);
      assert.deepEqual(afterFailure, expected);
      change();
      const restarted = new Accounts(file).list();
      assert.deepEqual(restarted, accounts.list());
      if (operation === 'add') assert.equal(restarted.filter(a => a.userId === added.userId).length, 1);
      if (operation === 'name') assert.equal(restarted[0].name, 'Changed');
      if (operation === 'room') assert.equal(restarted[0].roomId, '!new:example.com');
      if (operation === 'settings') assert.deepEqual(restarted[0].engineSettings, { model: 'test-model' });
    });
  }
}
