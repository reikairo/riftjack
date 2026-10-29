import { dirname } from 'node:path';
import type { MatrixClient } from '@vector-im/matrix-bot-sdk';
import { Accounts, PublicError, type Account } from './accounts.js';
import { imageMime, readOutgoing, type IncomingAttachment } from './media.js';
import { inlineCode, markdownText } from './manager-format.js';

export type ProfileRequest = { action: 'rename'; userId: string; name: string }
  | { action: 'avatar' | 'remove-avatar'; userId: string };

function validTarget(target: string): boolean {
  return !!target && !/[\x00-\x1f\x7f]/.test(target) &&
    (!target.startsWith('@') || /^@[^\s@:]+(?::[^\s]+)?$/.test(target));
}

export function parseProfileRequest(text: string): ProfileRequest | null {
  const rename = /^rename bot (?:"([^"\r\n]+)"|([^"\r\n]+?)) to (.+)$/i.exec(text.trim());
  if (rename) {
    const target = (rename[1] ?? rename[2]).trim();
    if (!validTarget(target)) return null;
    const name = rename[3].trim();
    if (!name || [...name].length > 100 || /[\x00-\x1f\x7f]/.test(name)) return null;
    return { action: 'rename', userId: target, name };
  }
  const avatar = /^(set|remove) avatar (?:"([^"\r\n]+)"|([^"\r\n]+))$/i.exec(text.trim());
  if (!avatar) return null;
  const target = (avatar[2] ?? avatar[3]).trim();
  return validTarget(target) ? { action: avatar[1].toLowerCase() === 'set' ? 'avatar' : 'remove-avatar', userId: target } : null;
}

export function canManageProfile(account: Account, sender: string, owner: string): boolean {
  return sender === owner || (account.kind !== 'manager' && sender === account.inviteUserId);
}

type ProfileClient = Pick<MatrixClient, 'setDisplayName' | 'setAvatarUrl' | 'uploadContent'>;
function matchesProfileTarget(account: Account, target: string): boolean {
  // A full Matrix ID is exact, even if another bot uses it as a name.
  if (target.startsWith('@') && target.includes(':')) return account.userId === target;
  const local = account.userId.slice(1, account.userId.indexOf(':'));
  const short = target.replace(/^@/, '');
  const generatedAlias = /^bot_(?:codex|claude|pi|grok|manager)_.+_[a-f0-9]{12}$/.test(local)
    ? local.replace(/_[a-f0-9]{12}$/, '') : undefined;
  const nameMatches = !target.startsWith('@') &&
    account.name.trim().normalize('NFC').toLowerCase() === target.normalize('NFC').toLowerCase();
  return local === short || generatedAlias === short || nameMatches;
}

export function resolveProfileTarget(accounts: Accounts, target: string, sender: string, owner: string): Account {
  const matches = accounts.list().filter(a => matchesProfileTarget(a, target));
  if (matches.length > 1) throw new PublicError('Several bots match this name or ID. Specify the full Matrix ID:\n' +
    matches.map(a => `${a.name}: ${a.userId}`).join('\n'));
  const account = matches[0];
  if (!account) throw new PublicError('No bot found with that name or Matrix ID. Check list bots.');
  if (!canManageProfile(account, sender, owner)) throw new PublicError('Only the connector owner or this bot’s creator can change its profile.');
  return account;
}

export async function updateBotProfile(request: ProfileRequest, options: {
  accounts: Accounts; owner: string; sender: string; signal: AbortSignal; maxBytes: number;
  client: (userId: string) => ProfileClient | undefined;
  attachments: IncomingAttachment[];
}): Promise<string> {
  const { accounts, owner, sender, signal, attachments } = options;
  signal.throwIfAborted();
  const account = resolveProfileTarget(accounts, request.userId, sender, owner);
  const client = options.client(account.userId);
  if (!client) throw new PublicError('The bot is disconnected. Restore its connection first.');
  if (request.action !== 'avatar' && attachments.length) throw new PublicError('This command does not need an attachment. Send it as text.');
  if (request.action === 'rename') {
    await client.setDisplayName(request.name);
    accounts.setName(account.userId, request.name);
    return `**Bot renamed:** ${markdownText(request.name)}\nMatrix ID unchanged: ${inlineCode(account.userId)}`;
  }
  if (request.action === 'remove-avatar') {
    await client.setAvatarUrl('');
    return `**Avatar removed:** ${markdownText(account.name)}\n${inlineCode(account.userId)}`;
  }
  if (attachments.length !== 1) throw new PublicError('Attach one image with the caption: set avatar ' + request.userId);
  const file = attachments[0];
  const data = await readOutgoing({ path: file.path, root: dirname(file.path) }, options.maxBytes);
  const mime = imageMime(data);
  if (!mime) throw new PublicError('Avatars must be PNG, JPEG, GIF or WebP images.');
  signal.throwIfAborted();
  // Profile images are ordinary Matrix media, not encrypted room attachments.
  const url = await client.uploadContent(data, mime);
  signal.throwIfAborted();
  await client.setAvatarUrl(url);
  return `**Avatar updated:** ${markdownText(account.name)}\n${inlineCode(account.userId)}\nThe image is visible in the Matrix profile.`;
}
