import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSysctlTable, resolvePython, selectProcessTable, sysctlFailure, track, type ProcessRow } from '../scripts/detached-runner.mjs';

// Strict runs require every process table source available on this platform instead of skipping when one is refused.
const strict = process.env.RIFTJACK_TEST_REQUIRE_PROCESS_TABLES === '1';
// Only an environment refusing a process table (EPERM) skips a check; any other error fails the test.
function refused(error: any) {
  if (error?.code !== 'EPERM' || strict) throw error;
}
const row = (pid: number, ppid: number, birth: string, state = 'S'): ProcessRow => ({ pid, ppid, pgid: pid, state, birth });
const pids = (rows: ProcessRow[]) => rows.map(p => p.pid).sort((a, b) => a - b);

test('a reused PID is neither alive nor a parent of tracked processes', () => {
  const observed = new Map([[20, row(20, 1, 'first')]]);
  assert.deepEqual(track([row(20, 1, 'second'), row(21, 20, 'child')], observed), []);
  assert.equal(observed.has(21), false);
});

test('a process missing from a later table is no longer alive', () => {
  const observed = new Map([[20, row(20, 1, 'first')]]);
  assert.deepEqual(pids(track([row(20, 1, 'first')], observed)), [20]);
  assert.deepEqual(track([row(30, 1, 'other')], observed), []);
});

test('descendants stay tracked after their parents exit and they are reparented', () => {
  const observed = new Map([[10, row(10, 1, 'root')]]);
  assert.deepEqual(pids(track([row(10, 1, 'root'), row(11, 10, 'child'), row(12, 11, 'grandchild')], observed)), [10, 11, 12]);
  assert.deepEqual(pids(track([row(12, 1, 'grandchild')], observed)), [12]);
});

test('a descendant whose parent exited between two tables is not tracked', () => {
  // The observation interval bounds this: the whole chain to an observed process
  // must be alive in some table for a descendant to be tracked.
  const observed = new Map([[10, row(10, 1, 'root')]]);
  assert.deepEqual(pids(track([row(10, 1, 'root'), row(12, 1, 'orphan')], observed)), [10]);
});

test('zombies are not alive', () => {
  const observed = new Map([[10, row(10, 1, 'root')]]);
  assert.deepEqual(track([row(10, 1, 'root', 'Z')], observed), []);
});

test('kern.proc.all output is accepted only when complete', () => {
  const output = (...rows: string[]) => ['riftjack-process-table ' + rows.length, ...rows, 'end', ''].join('\n');
  const line = '1 0 1 S Sat Nov  7 16:52:58 2026';
  assert.deepEqual(parseSysctlTable(output(line)), [{ pid: 1, ppid: 0, pgid: 1, state: 'S', birth: 'Sat Nov  7 16:52:58 2026' }]);
  for (const broken of [
    output(line).replace('end\n', ''),
    output(line).replace('table 1', 'table 2'),
    output('1 0 S Sat Nov  7 16:52:58 2026'),
    output(line).slice(0, -1),
    line + '\nend\n',
  ]) assert.throws(() => parseSysctlTable(broken), /incomplete/);
});

test('only a refused sysctl counts as the environment refusing kern.proc.all', () => {
  const output = (reason: string) => `riftjack-process-table error: ${reason}\n`;
  for (const reason of ['size_errno_1', 'read_errno_1']) {
    assert.equal(sysctlFailure(output(reason), 3)?.code, 'EPERM');
  }
  for (const reason of ['size_errno_12', 'unexpected_layout', 'unexpected_state', 'unexpected_record_size', 'table_kept_growing']) {
    const error = sysctlFailure(output(reason), 3);
    assert.match(String(error?.message), new RegExp(reason));
    assert.equal(error?.code, undefined);
  }
  assert.match(String(sysctlFailure('', 1)?.message), /exited with status 1/);
  assert.equal(sysctlFailure('', null), null);
});

test('an unknown process table source is refused', () => {
  assert.throws(() => selectProcessTable('top'), /must be ps or sysctl/);
});

test('a missing Python is reported with its path', () => {
  assert.throws(() => resolvePython('/nonexistent/python3'), /needs Python 3 at \/nonexistent\/python3/);
});

test('kern.proc.all reports this process with the identity ps reports', async t => {
  if (process.platform !== 'darwin') return t.skip('kern.proc.all is read only on macOS.');
  let sysctl;
  try { sysctl = selectProcessTable('sysctl'); }
  catch (error) {
    refused(error);
    return t.skip('This environment refuses the kern.proc.all sysctl.');
  }
  assert.equal(sysctl.source, 'sysctl');
  const self = sysctl.read().find(p => p.pid === process.pid);
  assert.equal(self?.ppid, process.ppid);
  let ps;
  try { ps = selectProcessTable('ps'); }
  catch (error) {
    refused(error);
    return t.diagnostic('This environment refuses /bin/ps, so births were not compared.');
  }
  assert.equal(ps.read().find(p => p.pid === process.pid)?.birth, self?.birth);
});
