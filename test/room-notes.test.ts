import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomNotes, NOTES_BYTES, notesAction, notesCommand } from '../src/room-notes.js';

function fixture(t: { after: (callback: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'room-notes-')), file = join(dir, 'notes.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { notes: new RoomNotes(file), file };
}

test('room documents persist, isolate rooms, and reject stale edits', t => {
  const { notes, file } = fixture(t);
  assert.equal(notes.read('!one:test').version, 0);
  notes.set('!one:test', 'План', 0, '@alice:test');
  assert.equal(notes.read('!two:test').text, '');
  assert.throws(() => notes.set('!one:test', 'overwrite', 0, '@bob:test'), /Notes changed/);
  const copy = notes.read('!one:test'); copy.text = 'overwrite';
  assert.equal(new RoomNotes(file).read('!one:test').text, 'План');
  assert.equal(notes.read('!one:test').author, '@alice:test');
  assert.equal(JSON.parse(notesAction(notes, '!one:test', '@bot:test', { action: 'read' }, false)).text, 'План');
  assert.throws(() => notesAction(notes, '!one:test', '@bot:test', { action: 'clear', expectedVersion: 1 }, false), /only read/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('clear and restore create new revisions, history is bounded and copied', t => {
  const { notes } = fixture(t);
  notes.set('!room:test', 'first', 0, '@alice:test');
  notes.set('!room:test', '', 1, '@alice:test');
  assert.equal(notes.restore('!room:test', 1, 2, '@bob:test').text, 'first');
  assert.equal(notes.read('!room:test').version, 3);
  const history = notes.history('!room:test'); history[1].text = 'mutated';
  assert.equal(notes.history('!room:test')[1].text, 'first');
  for (let version = 3; version < 30; version++) notes.set('!room:test', String(version), version, '@alice:test');
  assert.equal(notes.history('!room:test').length, 20);
  assert.throws(() => notes.restore('!room:test', 1, 30, '@alice:test'), /no longer/);
});

test('failed persistence preserves the last document and revision in memory and on disk', t => {
  const { notes, file } = fixture(t);
  notes.set('!room:test', 'original', 0, '@alice:test');
  mkdirSync(file + '.tmp');
  assert.throws(() => notes.set('!room:test', 'not saved', 1, '@alice:test'));
  assert.equal(notes.read('!room:test').version, 1);
  assert.equal(new RoomNotes(file).read('!room:test').text, 'original');
});

test('UTF-8 limits, action fields, versions and corrupt state fail closed', t => {
  const { notes, file } = fixture(t);
  notes.set('!room:test', 'я'.repeat(NOTES_BYTES / 2), 0, '@alice:test');
  assert.throws(() => notes.set('!room:test', 'я'.repeat(NOTES_BYTES / 2 + 1), 1, '@alice:test'));
  for (const input of [null, [], {}, { action: 'set', text: 'x' }, { action: 'read', room: '!other:test' },
    { action: 'set', text: 'x', expectedVersion: -1 }, { action: 'restore', version: '0', expectedVersion: 1 }]) {
    assert.throws(() => notesAction(notes, '!room:test', '@bot:test', input));
  }
  writeFileSync(file, JSON.stringify({ version: 1, rooms: { '!room:test': { current: {}, history: [] } } }));
  assert.throws(() => new RoomNotes(file), /Invalid room notes/);
});

test('commands support multiline text, clear, history and restore with explicit versions', t => {
  const { notes } = fixture(t), command = (s: string) => JSON.parse(notesCommand(notes, '!room:test', '@alice:test', s));
  assert.equal(command('!notes').version, 0);
  assert.equal(command('!notes set 0 line one\nline two').text, 'line one\nline two');
  assert.equal(command('!notes clear 1').text, '');
  assert.equal(command('!notes history').length, 2);
  assert.equal(command('!notes restore 1 2').text, 'line one\nline two');
  assert.throws(() => command('!notes clear'), /Use !notes/);
});

test('context follows room and version, acknowledges snapshots, and resets after compaction', t => {
  const { notes } = fixture(t);
  notes.set('!private:test', 'private reference', 0, '@alice:test');
  const first = notes.context('session', '!private:test');
  assert.match(first.text, /private reference/);
  assert.deepEqual(JSON.parse(first.text.split('\n')[1]), { room: '!private:test', ...notes.read('!private:test') });
  assert.ok(notes.context('session', '!private:test').text); // no receipt yet
  first.delivered();
  assert.equal(notes.context('session', '!private:test').text, '');
  const shared = notes.context('session', '!shared:test');
  assert.deepEqual(JSON.parse(shared.text.split('\n')[1]), { room: '!shared:test', version: 0, text: '', author: '', updatedAt: '' });
  assert.ok(!shared.text.includes('private reference')); shared.delivered();
  assert.match(notes.context('session', '!private:test').text, /private reference/);
  const old = notes.context('session', '!shared:test');
  notes.set('!shared:test', 'new reference', 0, '@alice:test'); old.delivered();
  const updated = notes.context('session', '!shared:test'); assert.match(updated.text, /new reference/);
  notes.forget('session'); updated.delivered();
  assert.match(notes.context('session', '!shared:test').text, /new reference/);
});
