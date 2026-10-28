import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preparePublish, pushReviewedBatch, requestPublish, publishInput } from '../src/publish.js';

const signal = () => new AbortController().signal;
function setup(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'publish-batch-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), remote = join(root, 'remote.git'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('init', '--bare', '-b', 'main', remote);
  writeFileSync(join(repo, 'file'), 'base\n'); git('add', '.'); git('commit', '-m', 'Base');
  const base = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', remote); git('push', 'origin', 'main', 'main:lower');
  writeFileSync(join(repo, 'file'), 'base\n<script>new</script>\n'); git('add', '.'); git('commit', '-m', 'First');
  const first = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-m', 'Second'); const second = git('rev-parse', 'HEAD');
  const input = { repository: repo, remote: 'origin', branches: [{ branch: 'lower', head: first }, { branch: 'upper', head: second }] };
  const tip = (branch: string) => git('ls-remote', '--refs', 'origin', 'refs/heads/' + branch).split('\t')[0] || null;
  const prepare = () => preparePublish(input, root, signal());
  return { root, repo, remote, git, base, first, second, input, tip, prepare };
}

test('one review approves exact branch SHAs despite later checkout changes, without tags or dirty files', async t => {
  const f = setup(t); let approvals = 0, attachment = '';
  writeFileSync(join(f.repo, 'private'), 'PRIVATE_UNTRACKED');
  f.git('tag', '-a', 'unrelated', '-m', 'Tag'); f.git('config', 'push.followTags', 'true');
  const result = await requestPublish(f.input, f.root, f.root, 8 * 1024 * 1024, signal(), async request => {
    approvals++; assert.equal(request.attachments?.length, 1);
    attachment = request.attachments![0].path;
    const html = readFileSync(attachment, 'utf8');
    assert.match(html, /Atomic publication package/); assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /PRIVATE_UNTRACKED|<script>/);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
    assert.equal(ids.length, new Set(ids).size);
    for (const link of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(link[1]), link[1]);
    assert.equal(f.tip('lower'), f.base); assert.equal(f.tip('upper'), null);
    // No local branch named lower or upper is required. Neither HEAD nor the
    // caller's mutable input can change the already-reviewed package.
    f.git('switch', '--detach', f.base); f.input.branches[0].head = f.base;
    return { publish: true };
  }, async () => {});
  assert.match(result, /Published atomic batch/); assert.equal(approvals, 1);
  assert.equal(f.tip('lower'), f.first); assert.equal(f.tip('upper'), f.second);
  assert.equal(f.git('ls-remote', '--tags', 'origin'), ''); assert.equal(existsSync(attachment), false);
});

test('mixed rewrite, update and creation reports removed history for the right branch', async t => {
  const f = setup(t);
  const old = f.git('commit-tree', f.git('rev-parse', 'HEAD^{tree}'), '-p', f.base, '-m', 'Old branch history');
  f.git('push', 'origin', old + ':refs/heads/rewrite');
  f.input.branches.push({ branch: 'rewrite', head: f.first });
  const review = await f.prepare();
  assert.equal(review.branches[2].historyReplacement, true);
  assert.deepEqual(review.branches[2].removedHistory.map(c => c.oid), [old]);
  assert.ok(review.html.includes('href="#branch-2-removed"'));
  assert.match(review.html, /Old branch history/); assert.match(review.html, /HISTORY REPLACEMENT/);
  await pushReviewedBatch(review, signal()); assert.equal(f.tip('rewrite'), f.first);
});

for (const failure of ['decline', 'delivery', 'cancel', 'access', 'attachment'] as const) test(`batch ${failure} publishes no branches`, async t => {
  const f = setup(t), controller = new AbortController(); let attachment = '';
  const run = () => requestPublish(f.input, f.root, f.root, failure === 'attachment' ? 1 : 8 * 1024 * 1024, controller.signal, async request => {
    attachment = request.attachments![0].path;
    if (failure === 'delivery') throw new Error('delivery failed');
    if (failure === 'cancel') controller.abort(new Error('cancelled'));
    return { publish: failure !== 'decline' };
  }, async () => { if (failure === 'access') throw new Error('access revoked'); });
  if (failure === 'decline') assert.match(await run(), /declined/); else await assert.rejects(run);
  assert.equal(f.tip('lower'), f.base); assert.equal(f.tip('upper'), null);
  if (attachment) assert.equal(existsSync(attachment), false);
});

for (const branch of ['lower', 'upper']) test(`changed ${branch} tip before push invalidates whole review`, async t => {
  const f = setup(t), review = await f.prepare();
  f.git('push', 'origin', f.second + ':refs/heads/' + branch);
  await assert.rejects(pushReviewedBatch(review, signal()), /changed after review/);
  assert.equal(f.tip(branch === 'lower' ? 'upper' : 'lower'), branch === 'lower' ? null : f.base);
});

test('lease race after revalidation cannot partially create the other branch', async t => {
  const f = setup(t), review = await f.prepare();
  await assert.rejects(pushReviewedBatch(review, signal(), async () => {
    f.git('push', 'origin', f.second + ':refs/heads/lower');
  }), /Atomic publication was not confirmed/);
  assert.equal(f.tip('lower'), f.second); assert.equal(f.tip('upper'), null);
});

for (const mode of ['hook', 'unsupported'] as const) test(`atomic ${mode} refusal leaves every branch unchanged`, async t => {
  const f = setup(t), review = await f.prepare();
  if (mode === 'hook') writeFileSync(join(f.remote, 'hooks', 'update'), '#!/bin/sh\n[ "$1" != refs/heads/upper ]\n', { mode: 0o755 });
  else f.git('--git-dir=' + f.remote, 'config', 'receive.advertiseAtomic', 'false');
  await assert.rejects(pushReviewedBatch(review, signal()), /No non-atomic fallback/);
  assert.equal(f.tip('lower'), f.base); assert.equal(f.tip('upper'), null);
});

test('changed push URL prevents batch publication', async t => {
  const f = setup(t), review = await f.prepare();
  f.git('remote', 'set-url', '--push', 'origin', join(f.root, 'other.git'));
  await assert.rejects(pushReviewedBatch(review, signal()), /destination changed/);
});

test('batch validates exclusive mode, unique branches and exact commit objects', async t => {
  const f = setup(t);
  for (const branches of [[], Array(21).fill(f.input.branches[0]), [f.input.branches[0], f.input.branches[0]],
    [{ branch: 'x', head: 'HEAD' }], [{ branch: '--all', head: f.first }], [{ branch: 'x', head: f.first, extra: true }]]) {
    assert.throws(() => publishInput({ ...f.input, branches }));
  }
  assert.throws(() => publishInput({ ...f.input, branch: 'main' }));
  f.git('tag', '-a', 'annotated', '-m', 'Tag');
  for (const head of [f.git('rev-parse', 'annotated'), f.git('rev-parse', 'HEAD^{tree}')]) {
    await assert.rejects(preparePublish({ ...f.input, branches: [{ branch: 'x', head }] }, f.root, signal()), /commit object/);
  }
  await assert.rejects(preparePublish({ ...f.input, branches: [{ branch: 'bad..ref', head: f.first }] }, f.root, signal()));
});

test('package counts shared commits once and enforces combined distinct limit', async t => {
  const f = setup(t), tree = f.git('rev-parse', 'HEAD^{tree}');
  let head = f.base;
  const commits: string[] = [];
  for (let i = 0; i < 60; i++) { head = f.git('commit-tree', tree, '-p', head, '-m', 'Shared ' + i); commits.push(head); }
  const review = await preparePublish({ ...f.input, branches: [{ branch: 'one', head }, { branch: 'two', head: commits[58] }] }, f.root, signal());
  assert.equal(review.branches[0].commits.length, 60); assert.equal(review.branches[1].commits.length, 59);
  let other = f.base;
  for (let i = 0; i < 41; i++) other = f.git('commit-tree', tree, '-p', other, '-m', 'Distinct ' + i);
  await assert.rejects(preparePublish({ ...f.input, branches: [{ branch: 'one', head }, { branch: 'two', head: other }] }, f.root, signal()), /100 distinct/);
});

test('report-only CLI returns all immutable heads without publishing', async t => {
  const f = setup(t), path = join(f.root, 'batch.html');
  const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/prepare-publish.mts', '--workspace', f.root,
    '--request', JSON.stringify(f.input), '--output', path], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.atomic, true); assert.equal(result.published, false);
  assert.deepEqual(result.branches.map((b: { head: string }) => b.head), [f.first, f.second]);
  assert.equal(f.tip('lower'), f.base); assert.equal(f.tip('upper'), null);
});
