import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PublicError } from './errors.js';
import { renderPublishReview, renderPublishBatchReview } from './publish-html.js';
import { confirmationDetails } from './confirmation-format.js';
import type { Interact } from './interactions.js';

const exec = promisify(execFile);
const LIMIT = 8 * 1024 * 1024;
export type ReviewBaseInput = Readonly<{ remote: string; branch: string }>;
type PublishCommon = { repository: string; remote: string; review_base?: ReviewBaseInput };
export type PublishInput = PublishCommon & { branch: string };
export type PublishBatchInput = PublishCommon & { branches: readonly Readonly<{ branch: string; head: string }>[] };
export type PublicationInput = PublishInput | PublishBatchInput;
export type PublishBatchReview = Readonly<{
  repository: string; remote: string; url: string; createdAt: string;
  branches: readonly PublishReview[]; html: string; sha256: string;
}>;
export type PublishReview = Readonly<PublishInput & {
  url: string; base: string | null; reviewBase: string | null;
  baseReference: Readonly<{ ref: string; head: string }> | null; head: string; createdAt: string;
  upstreamReference: Readonly<{ remote: string; url: string; ref: string; head: string }> | null;
  publishedReferences: readonly Readonly<{ ref: string; head: string }>[];
  publishedHistory: readonly string[];
  commits: readonly string[]; patch: string; history: readonly { oid: string; patch: string }[];
  historyReplacement: boolean; removedHistory: readonly { oid: string; patch: string }[];
  workingTreeDirty: boolean; html: string; sha256: string;
}>;

export function publishInput(value: unknown): PublicationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PublicError('Supply repository, remote and branch.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['repository', 'remote', 'branch', 'branches', 'review_base'].includes(k)) ||
      typeof v.repository !== 'string' || !v.repository || v.repository.length > 4096 || /[\x00-\x1f]/.test(v.repository) ||
      typeof v.remote !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v.remote)) {
    throw new PublicError('Supply repository, remote, branch or branches, and optionally review_base.');
  }
  const validBranch = (branch: unknown): branch is string => typeof branch === 'string' && !!branch && branch.length <= 255 && !branch.startsWith('-') && !/[\x00-\x20\x7f]/.test(branch);
  let review_base: ReviewBaseInput | undefined;
  if ('review_base' in v) {
    const base = v.review_base as Record<string, unknown> | null;
    if (!base || typeof base !== 'object' || Array.isArray(base) || Object.keys(base).some(k => !['remote', 'branch'].includes(k)) ||
        typeof base.remote !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(base.remote) || !validBranch(base.branch)) {
      throw new PublicError('review_base requires a configured remote name and a published branch name.');
    }
    review_base = Object.freeze({ remote: base.remote, branch: base.branch });
  }
  const common = { repository: v.repository, remote: v.remote, ...(review_base && { review_base }) };
  if ('branches' in v) {
    if ('branch' in v || !Array.isArray(v.branches) || !v.branches.length || v.branches.length > 20) {
      throw new PublicError('Supply either branch or branches (1–20 exact branch/head pairs), not both.');
    }
    const names = new Set<string>();
    const branches = v.branches.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !['branch', 'head'].includes(k)) ||
          !validBranch(item.branch) || typeof item.head !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.head)) {
        throw new PublicError('Each publication entry requires a branch name and a full lowercase commit SHA in head.');
      }
      if (names.has(item.branch)) throw new PublicError('Duplicate destination branch in publication batch.');
      names.add(item.branch);
      return Object.freeze({ branch: item.branch, head: item.head });
    });
    return { ...common, branches: Object.freeze(branches) };
  }
  if (!validBranch(v.branch)) throw new PublicError('Supply a destination branch name.');
  return { ...common, branch: v.branch };
}

async function git(repo: string, args: string[], signal: AbortSignal, input?: string): Promise<string> {
  signal.throwIfAborted();
  try {
    // Never interpret a shell command or inherit Git routing from the calling process.
    const allowed = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'SSH_AUTH_SOCK'];
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => allowed.includes(k)));
    const operation = exec('git', ['--no-pager', '-c', 'core.quotePath=true', ...args], {
      cwd: repo, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }, signal,
      timeout: 120_000, maxBuffer: LIMIT, encoding: 'utf8',
    });
    operation.child.stdin?.end(input);
    const { stdout } = await operation;
    return stdout;
  } catch (cause) {
    signal.throwIfAborted();
    const operation = args.find(arg => ['rev-parse', 'config', 'ls-remote', 'rev-list', 'diff', 'show', 'log', 'merge-base', 'status', 'push', 'for-each-ref', 'check-ref-format', 'cat-file'].includes(arg)) ?? 'request';
    // merge-base exits 1 for unrelated histories; let the caller explain it.
    if (operation === 'merge-base' && (cause as { code?: unknown }).code === 1) return '';
    if (['diff', 'show', 'rev-list'].includes(operation) && (cause as NodeJS.ErrnoException)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new PublicError('Publication review exceeds 8 MiB. For a fork rebased onto upstream, specify review_base with its published remote and branch. No truncated review or push was made.', { cause });
    }
    throw new PublicError(`Git review operation failed or exceeded its size/time limit (operation: ${operation}). Check repository access and Git authentication on the host.`, { cause });
  }
}

async function destination(repo: string, remote: string, signal: AbortSignal) {
  const urls = (await git(repo, ['remote', 'get-url', '--push', '--all', remote], signal)).trim().split('\n');
  if (urls.length !== 1 || !urls[0]) throw new PublicError('Publication requires exactly one push URL.');
  const url = urls[0];
  // Reject executable remote helpers and credentials embedded in HTTP URLs.
  if (/^https:\/\//.test(url)) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new PublicError('Use a credential-free HTTPS remote URL and host Git authentication.');
  } else if (!(/^ssh:\/\//.test(url) || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(url) || isAbsolute(url))) {
    throw new PublicError('Use an HTTPS, SSH, or absolute local-path remote.');
  }
  if (url.startsWith('ssh://') && new URL(url).password) throw new PublicError('Use SSH keys without a password embedded in the URL.');
  if (/[\x00-\x1f\x7f]/.test(url) || (!isAbsolute(url) && /\s/.test(url))) throw new PublicError('Invalid remote URL.');
  return url;
}

async function remoteHead(repo: string, url: string, ref: string, signal: AbortSignal): Promise<string | null> {
  const output = (await git(repo, ['ls-remote', '--refs', '--', url, ref], signal)).trim();
  if (!output) return null;
  const lines = output.split('\n');
  const [oid, name] = lines[0].split('\t');
  if (lines.length !== 1 || name !== ref || !/^[a-f0-9]{40,64}$/.test(oid)) throw new PublicError('Unexpected remote branch response.');
  return oid;
}

// Default to an advertised branch on the publication destination. An explicitly
// selected upstream is verified separately; local tracking refs are never trusted.
async function defaultBranch(repo: string, url: string, signal: AbortSignal) {
  const output = (await git(repo, ['ls-remote', '--symref', '--', url, 'HEAD'], signal)).trim();
  if (!output) return null;
  const lines = output.split('\n');
  const symbolic = lines.find(line => line.startsWith('ref: '));
  const tip = lines.find(line => /^[a-f0-9]{40,64}\tHEAD$/.test(line));
  if (!symbolic || !tip || lines.length !== 2) throw new PublicError('The remote HEAD must name a branch before preparing a new-branch review.');
  const match = /^ref: (refs\/heads\/[^\s]+)\tHEAD$/.exec(symbolic);
  if (!match) throw new PublicError('Unexpected remote default branch response.');
  await git(repo, ['check-ref-format', match[1]], signal);
  return Object.freeze({ ref: match[1], head: tip.split('\t')[0] });
}

// Read the push destination itself: local tracking refs may be stale or forged.
async function publishedBranches(repo: string, url: string, signal: AbortSignal) {
  const output = (await git(repo, ['ls-remote', '--heads', '--', url], signal)).trim();
  if (!output) return [];
  return output.split('\n').map(line => {
    const match = /^([a-f0-9]{40,64})\t(refs\/heads\/[^\s]+)$/.exec(line);
    if (!match) throw new PublicError('Unexpected published branch response.');
    return Object.freeze({ ref: match[2], head: match[1] });
  });
}

async function publicationContext(input: PublicationInput, workspace: string, signal: AbortSignal) {
  const root = await realpath(workspace), repository = await realpath(resolve(root, input.repository));
  const rel = relative(root, repository);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new PublicError('Repository must be inside this bot’s workspace.');
  if ((await realpath((await git(repository, ['rev-parse', '--show-toplevel'], signal)).trim())) !== repository) throw new PublicError('Choose the repository root directory.');
  if ((await git(repository, ['rev-parse', '--is-shallow-repository'], signal)).trim() !== 'false') throw new PublicError('A complete repository history is required; shallow repositories cannot be reviewed.');
  const url = await destination(repository, input.remote, signal);
  const advertisedDefault = await defaultBranch(repository, url, signal);
  const publishedReferences = Object.freeze(await publishedBranches(repository, url, signal));
  if (advertisedDefault && !publishedReferences.some(ref => ref.ref === advertisedDefault.ref && ref.head === advertisedDefault.head)) {
    throw new PublicError('The remote default branch changed while preparing the review. Prepare a new report.');
  }
  const publishedTips = [...new Set(publishedReferences.map(ref => ref.head))];
  // Fetch once for the whole package without changing shared tracking refs.
  if (publishedTips.length) await git(repository, ['fetch', '--no-tags', '--no-write-fetch-head', '--', url, ...publishedTips], signal);
  let upstreamReference: PublishReview['upstreamReference'] = null;
  if (input.review_base) {
    const { remote, branch } = input.review_base;
    const ref = 'refs/heads/' + branch;
    await git(repository, ['check-ref-format', ref], signal);
    const upstreamUrl = await destination(repository, remote, signal);
    const head = await remoteHead(repository, upstreamUrl, ref, signal);
    if (!head) throw new PublicError('The review_base branch is not published on its remote.');
    await git(repository, ['fetch', '--no-tags', '--no-write-fetch-head', '--', upstreamUrl, head], signal);
    upstreamReference = Object.freeze({ remote, url: upstreamUrl, ref, head });
  }
  return { repository, url, advertisedDefault, publishedReferences, publishedTips, upstreamReference };
}

type PublicationContext = Awaited<ReturnType<typeof publicationContext>>;

async function prepareBranch(input: PublishInput, context: PublicationContext, head: string, signal: AbortSignal): Promise<PublishReview> {
  const { repository, url, advertisedDefault, publishedReferences, publishedTips, upstreamReference } = context;
  const verifiedTips = [...publishedTips, ...(upstreamReference ? [upstreamReference.head] : [])];
  await git(repository, ['check-ref-format', 'refs/heads/' + input.branch], signal);
  if ((await git(repository, ['cat-file', '-t', head], signal)).trim() !== 'commit') throw new PublicError('Publication head must be a commit object.');
  const base = publishedReferences.find(ref => ref.ref === 'refs/heads/' + input.branch)?.head ?? null;
  if (base === head) throw new PublicError(`The destination ${input.branch} already contains this HEAD; there is nothing to publish. Omit unchanged branches.`);
  let historyReplacement = false;
  if (base) {
    // A shared ancestor keeps this a branch update, not replacement by an unrelated repository.
    const ancestors = (await git(repository, ['merge-base', '--all', base, head], signal)).trim().split('\n');
    if (ancestors.length !== 1 || !/^[a-f0-9]{40,64}$/.test(ancestors[0])) {
      throw new PublicError('History replacement requires a unique common ancestor with the destination.');
    }
    historyReplacement = ancestors[0] !== base;
  }
  let reviewBase = base;
  const baseReference = (upstreamReference || (base && advertisedDefault?.ref === 'refs/heads/' + input.branch)) ? null : advertisedDefault;
  const diffReference = upstreamReference ?? baseReference;
  if (diffReference) {
    const ancestors = (await git(repository, ['merge-base', '--all', head, diffReference.head], signal)).trim().split('\n');
    if (ancestors.length !== 1 || !/^[a-f0-9]{40,64}$/.test(ancestors[0])) {
      throw new PublicError('A publication review requires a unique common ancestor with the published review base.');
    }
    reviewBase = ancestors[0];
  }
  // The PR diff is relative to the published main; push safety and outgoing
  // history are still relative to the exact destination branch tip.
  const historyRange = base ? base + '..' + head : reviewBase ? reviewBase + '..' + head : head;
  const commitList = (await git(repository, ['rev-list', '--max-count=101', '--reverse', historyRange,
    ...(verifiedTips.length ? ['--not', ...verifiedTips] : [])], signal)).trim();
  const commits = commitList ? commitList.split('\n') : [];
  const outgoingList = (await git(repository, ['rev-list', '--reverse', historyRange], signal)).trim();
  const novel = new Set(commits);
  const publishedHistory = Object.freeze(outgoingList ? outgoingList.split('\n').filter(oid => !novel.has(oid)) : []);
  const removedList = historyReplacement
    ? (await git(repository, ['rev-list', '--max-count=101', '--reverse', head + '..' + base], signal)).trim() : '';
  const removed = removedList ? removedList.split('\n') : [];
  if (commits.length + removed.length > 100) throw new PublicError('Review exceeds 100 outgoing and removed commits. Prepare a smaller publication.');
  const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--ignore-submodules=none'];
  const emptyTree = reviewBase ? undefined : (await git(repository, ['hash-object', '-w', '-t', 'tree', '--stdin'], signal, '')).trim();
  const patch = reviewBase ? await git(repository, ['diff', ...diffOptions, reviewBase, head, '--'], signal)
    : await git(repository, ['diff', ...diffOptions, emptyTree!, head, '--'], signal);
  let size = Buffer.byteLength(patch) + publishedHistory.join('\n').length;
  if (size > LIMIT) throw new PublicError('Complete review exceeds 8 MiB of text. No truncated review will be approved.');
  async function readHistory(oids: string[]) {
    const history: { oid: string; patch: string }[] = [];
    for (const oid of oids) {
      const content = await git(repository, ['show', '--format=fuller', '--root', '--diff-merges=first-parent', ...diffOptions, oid, '--'], signal);
      size += Buffer.byteLength(content);
      if (size > LIMIT) throw new PublicError('Complete review exceeds 8 MiB of text. No truncated review will be approved.');
      history.push(Object.freeze({ oid, patch: content }));
    }
    return Object.freeze(history);
  }
  const history = await readHistory(commits), removedHistory = await readHistory(removed);
  const workingTreeDirty = !!(await git(repository, ['status', '--porcelain', '--untracked-files=normal'], signal)).trim();
  const data = { ...input, repository, url, base, reviewBase, baseReference, upstreamReference, head, createdAt: new Date().toISOString(), commits: Object.freeze(commits), patch,
    history, historyReplacement, removedHistory, publishedReferences, publishedHistory, workingTreeDirty };
  const html = renderPublishReview(data);
  return Object.freeze({ ...data, html, sha256: createHash('sha256').update(html).digest('hex') });
}

export function preparePublish(input: PublishInput, workspace: string, signal: AbortSignal): Promise<PublishReview>;
export function preparePublish(input: PublishBatchInput, workspace: string, signal: AbortSignal): Promise<PublishBatchReview>;
export function preparePublish(input: PublicationInput, workspace: string, signal: AbortSignal): Promise<PublishReview | PublishBatchReview>;
export async function preparePublish(input: PublicationInput, workspace: string, signal: AbortSignal): Promise<PublishReview | PublishBatchReview> {
  input = publishInput(input);
  const context = await publicationContext(input, workspace, signal);
  if ('branch' in input) {
    const head = (await git(context.repository, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim();
    return prepareBranch(input, context, head, signal);
  }
  const branches: PublishReview[] = [];
  const commits = new Set<string>();
  let size = 0;
  for (const entry of input.branches) {
    const branch = await prepareBranch({ repository: input.repository, remote: input.remote, review_base: input.review_base, branch: entry.branch }, context, entry.head, signal);
    for (const oid of [...branch.commits, ...branch.removedHistory.map(c => c.oid)]) commits.add(oid);
    if (commits.size > 100) throw new PublicError('Batch review exceeds 100 distinct outgoing and removed commits. Prepare a smaller publication.');
    size += Buffer.byteLength(branch.html);
    if (size > LIMIT) throw new PublicError('Complete batch review exceeds 8 MiB of text. No truncated review will be approved.');
    branches.push(branch);
  }
  const data = { repository: context.repository, remote: input.remote, url: context.url, createdAt: new Date().toISOString(), branches: Object.freeze(branches) };
  const html = renderPublishBatchReview(data);
  if (Buffer.byteLength(html) > LIMIT) throw new PublicError('Complete batch review exceeds 8 MiB of text. No truncated review will be approved.');
  return Object.freeze({ ...data, html, sha256: createHash('sha256').update(html).digest('hex') });
}

async function verifyUpstream(review: PublishReview, signal: AbortSignal): Promise<void> {
  const ref = review.upstreamReference;
  if (ref && (await destination(review.repository, ref.remote, signal) !== ref.url ||
      await remoteHead(review.repository, ref.url, ref.ref, signal) !== ref.head)) {
    throw new PublicError('The published review base changed after review. Prepare a new report and request confirmation again. No push was made.');
  }
}

export async function pushReviewedBatch(review: PublishBatchReview, signal: AbortSignal, authorize: () => Promise<void> = async () => {}): Promise<void> {
  if (await destination(review.repository, review.remote, signal) !== review.url) {
    throw new PublicError('The destination changed after review. Prepare a new report and request confirmation again.');
  }
  const current = new Map((await publishedBranches(review.repository, review.url, signal)).map(ref => [ref.ref, ref.head]));
  for (const branch of review.branches) {
    await verifyUpstream(branch, signal);
    if ((current.get('refs/heads/' + branch.branch) ?? null) !== branch.base ||
        (branch.baseReference && current.get(branch.baseReference.ref) !== branch.baseReference.head) ||
        branch.publishedReferences.some(ref => current.get(ref.ref) !== ref.head)) {
      throw new PublicError(`Remote references changed after review (${branch.branch}). Prepare a new report and request confirmation again. No push was made.`);
    }
  }
  await authorize();
  signal.throwIfAborted();
  try {
    await git(review.repository, ['-c', 'push.followTags=false', 'push', '--atomic', '--porcelain', '--no-follow-tags', '--recurse-submodules=no',
      ...review.branches.map(b => '--force-with-lease=refs/heads/' + b.branch + ':' + (b.base ?? '')),
      '--', review.url, ...review.branches.map(b => b.head + ':refs/heads/' + b.branch)], signal);
  } catch (cause) {
    throw new PublicError('Atomic publication was not confirmed. No non-atomic fallback or automatic retry was attempted. An interrupted push may have completed; check all destination branches before retrying. The server must support atomic push.', { cause });
  }
}

export async function pushReviewed(review: PublishReview, signal: AbortSignal, authorize: () => Promise<void> = async () => {}): Promise<void> {
  await verifyUpstream(review, signal);
  if ((await git(review.repository, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim() !== review.head ||
      await destination(review.repository, review.remote, signal) !== review.url ||
      await remoteHead(review.repository, review.url, 'refs/heads/' + review.branch, signal) !== review.base ||
      (review.baseReference && await remoteHead(review.repository, review.url, review.baseReference.ref, signal) !== review.baseReference.head)) {
    throw new PublicError('HEAD or the destination changed after review. Prepare a new report and request confirmation again.');
  }
  const currentPublished = new Map((await publishedBranches(review.repository, review.url, signal)).map(ref => [ref.ref, ref.head]));
  if (review.publishedReferences.some(ref => currentPublished.get(ref.ref) !== ref.head)) {
    throw new PublicError('Published reference changed after review. Prepare a new report and request confirmation again.');
  }
  await authorize();
  signal.throwIfAborted();
  try {
    await git(review.repository, ['-c', 'push.followTags=false', 'push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no',
      '--force-with-lease=refs/heads/' + review.branch + ':' + (review.base ?? ''), '--', review.url, review.head + ':refs/heads/' + review.branch], signal);
  } catch (cause) {
    throw new PublicError('Publication was not confirmed. It may have reached the remote; check the destination before retrying. Nothing was retried automatically.', { cause });
  }
}

export async function requestPublish(input: unknown, workspace: string, reportRoot: string, maxBytes: number, signal: AbortSignal, interact: Interact, authorize: () => Promise<void>): Promise<string> {
  const review = await preparePublish(publishInput(input), workspace, signal);
  if ('branches' in review) return requestBatchPublication(review, reportRoot, maxBytes, signal, interact, authorize);
  if (Buffer.byteLength(review.html) > maxBytes) throw new PublicError('Complete HTML review exceeds the attachment limit.');
  const directory = await mkdtemp(join(reportRoot, 'publish-review-'));
  try {
    const name = 'publish-' + review.head.slice(0, 12) + '.html', path = join(directory, name);
    await writeFile(path, review.html, { flag: 'wx', mode: 0o600 });
    const decision = await interact({ ...confirmationDetails([
      { value: review.historyReplacement ? 'Replace the destination branch history with the attached reviewed history?' : 'Publish the commits in the attached HTML review?' },
      ...(review.historyReplacement ? [{ value: 'HISTORY REPLACEMENT: the listed removed commits will no longer be reachable from this branch. Review both outgoing and removed history. An exact remote-tip lease protects against concurrent updates.' }] : []),
      { label: 'Repository', value: review.repository, code: true }, { label: 'Destination', value: review.url + ' → ' + review.branch, code: true },
      { label: 'Remote destination tip', value: review.base ?? '[new branch]', code: true },
      ...(review.upstreamReference ? [{ label: 'Published upstream base', value: `${review.upstreamReference.url} ${review.upstreamReference.ref} @ ${review.upstreamReference.head}`, code: true as const }] : []),
      { label: 'Review base', value: review.reviewBase ?? '[empty tree]', code: true },
      ...(review.baseReference ? [{ label: 'Published base reference', value: review.baseReference.ref + ' @ ' + review.baseReference.head, code: true as const }] : []),
      { label: 'Publish HEAD', value: review.head, code: true },
      { label: 'New commits on destination', value: String(review.commits.length) },
      { label: 'Already published incoming commits', value: String(review.publishedHistory.length) },
      ...(review.historyReplacement ? [{ label: 'Removed commits', value: String(review.removedHistory.length) }] : []),
      { label: 'Report SHA-256', value: review.sha256, code: true },
      { value: 'Only this commit and its history are published. Local uncommitted files and unrelated tags are excluded. Changed HEAD or destination requires a new review.' },
    ]), attachments: [{ path, root: directory, name }], approve: { publish: true }, deny: { publish: false } }, signal);
    signal.throwIfAborted();
    if (!('publish' in decision) || decision.publish !== true) return 'Publication declined. No push was made.';
    await pushReviewed(review, signal, authorize);
    return `Published ${review.head} to ${review.remote}/${review.branch}.`;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function requestBatchPublication(review: PublishBatchReview, reportRoot: string, maxBytes: number, signal: AbortSignal, interact: Interact, authorize: () => Promise<void>): Promise<string> {
  if (Buffer.byteLength(review.html) > maxBytes) throw new PublicError('Complete HTML review exceeds the attachment limit.');
  const directory = await mkdtemp(join(reportRoot, 'publish-review-'));
  try {
    const name = 'publish-batch-' + review.sha256.slice(0, 12) + '.html', path = join(directory, name);
    await writeFile(path, review.html, { flag: 'wx', mode: 0o600 });
    const decision = await interact({ ...confirmationDetails([
      { value: `Publish all ${review.branches.length} branches in the attached review as one atomic operation?` },
      { label: 'Repository', value: review.repository, code: true },
      { label: 'Destination', value: review.url, code: true },
      ...review.branches.map(b => ({ label: b.branch, value: `${b.base ?? '[new branch]'} → ${b.head}${b.historyReplacement ? ' (HISTORY REPLACEMENT)' : ''}`, code: true })),
      { value: 'Review the outgoing and removed history for every branch. Approval covers this entire immutable package. Without approval nothing is pushed. If any remote tip changes, or the server does not support atomic push, the package fails without a partial-push fallback.' },
      { value: 'Only the listed commit SHAs are sent. Working-tree changes, other branches and tags are excluded. Local branch movement or checkout does not change the approved SHAs.' },
      { label: 'Report SHA-256', value: review.sha256, code: true },
    ]), attachments: [{ path, root: directory, name }], approve: { publish: true }, deny: { publish: false } }, signal);
    signal.throwIfAborted();
    if (!('publish' in decision) || decision.publish !== true) return 'Publication declined. No push was made.';
    await pushReviewedBatch(review, signal, authorize);
    return `Published atomic batch to ${review.remote}:\n` + review.branches.map(b => `${b.branch}: ${b.head}`).join('\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
