import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { Interact } from './interactions.js';
import { PublicError, safeErrorSummary, connectionHint } from './errors.js';
import { inlineCode, markdownText } from './manager-format.js';

export type UserCreation = { username: string; name: string };
export function parseUserCreation(text: string): UserCreation | null {
  if (!/^create (?:a )?(?:matrix )?user(?:\s|$)/i.test(text.trim())) return null;
  const match = /^create (?:a )?(?:matrix )?user ([a-z0-9][a-z0-9._=-]{0,63})(?: (?:named|called) (.+))?$/i.exec(text.trim());
  if (!match || match[1] !== match[1].toLowerCase() || (match[2] && ([...match[2]].length > 100 || /[\x00-\x1f\x7f]/.test(match[2])))) {
    throw new PublicError('Use create user alice or create user alice named Alice. Username: 1–64 lowercase ASCII letters, digits, . _ = -; start with a letter or digit.');
  }
  return { username: match[1], name: match[2]?.trim() || match[1] };
}

export async function createMatrixUser(config: Config, request: UserCreation, options: {
  sender: string; signal: AbortSignal; interact?: Interact;
  ready?: () => Promise<void>; fetcher?: typeof fetch;
}): Promise<string> {
  if (options.sender !== config.owner) throw new PublicError('Only the initial owner can create Matrix users through the manager.');
  if (!/^[a-z0-9][a-z0-9._=-]{0,63}$/.test(request.username) || !request.name || [...request.name].length > 100 || /[\x00-\x1f\x7f]/.test(request.name)) throw new PublicError('Invalid username or display name.');
  if (!config.adminToken) throw new PublicError('Set SYNAPSE_ADMIN_TOKEN in the connector configuration to create users.');
  if (!options.interact) throw new PublicError('Could not request confirmation. The user was not created.');
  const { signal } = options;
  signal.throwIfAborted();
  await options.ready?.();
  const fetcher = options.fetcher ?? fetch;
  let attempted = false;
  const api = async (step: string, path: string, body?: object, allow404 = false) => {
    signal.throwIfAborted();
    const admin = path.startsWith('/_synapse/');
    const base = admin ? config.adminUrl : config.homeserver;
    const failure = (detail: string) => new PublicError(`User creation: ${step}. ${detail}` +
      (attempted ? ' The creation request was already sent: the account may exist. Do not retry automatically; check the server and the record in data/created-users on the connector host.' : ''));
    let response: Response;
    try {
      response = await fetcher(base + path, {
        method: body ? (path.startsWith('/_synapse/admin/v2/users/') ? 'PUT' : 'POST') : 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.adminToken}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
      });
    } catch (error) {
      if (!attempted) signal.throwIfAborted();
      const detail = safeErrorSummary(error);
      throw failure(`${detail}. ${connectionHint(detail)}`);
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw failure(`HTTP ${response.status}. Check administrator permissions, connectivity and Synapse configuration.`);
    let data: unknown;
    try { data = await response.json(); }
    catch { throw failure('The server returned an unreadable response.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('Invalid server response.');
    return data as Record<string, unknown>;
  };
  const identity = await api('administrator check', '/_matrix/client/v3/account/whoami');
  if (typeof identity?.user_id !== 'string' || !/^@[^\s:]+:[^\s]+$/.test(identity.user_id)) throw new PublicError('Could not determine the Matrix server name from the administrator account.');
  const userId = `@${request.username}:${identity.user_id.slice(identity.user_id.indexOf(':') + 1)}`;
  if (userId.length > 255) throw new PublicError('The full Matrix ID is too long. Choose a shorter username.');
  const userPath = '/_synapse/admin/v2/users/' + encodeURIComponent(userId);
  const checkAvailable = async () => {
    if (await api('username check', userPath, undefined, true)) throw new PublicError('User ' + userId + ' already exists. Its password and profile were not changed.');
  };
  await checkAvailable();
  const answer = await options.interact({
    text: `Create a Matrix user?\nID: ${userId}\nName: ${request.name}\nA regular account with no administrator privileges or bot access. A random password will be sent to this encrypted DM.`,
    approve: { approved: true }, deny: { approved: false },
  }, signal);
  signal.throwIfAborted();
  if ((answer as { approved?: boolean }).approved !== true) return 'User creation cancelled.';
  await checkAvailable();
  signal.throwIfAborted();
  const password = randomBytes(24).toString('base64url');
  // Save before the remote write so a lost reply cannot lose the credentials.
  const directory = join(config.dataDir, 'created-users');
  const record = join(directory, createHash('sha256').update(userId).digest('hex') + '.json');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(record, JSON.stringify({ userId, name: request.name, password, homeserver: config.homeserver, status: 'pending', createdAt: new Date().toISOString() }, null, 2), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PublicError('A creation attempt for this username is already recorded in data/created-users. Check it on the connector host before trying again.');
    throw new PublicError('Could not save the recovery password. No creation request was sent.');
  }
  let created: Record<string, unknown> | null;
  if (config.registrationSecret) {
    const nonce = (await api('fetching nonce', '/_synapse/admin/v1/register'))?.nonce;
    if (typeof nonce !== 'string' || !nonce) throw new PublicError('Synapse did not return a registration nonce. The user was not created.');
    const mac = createHmac('sha1', config.registrationSecret).update([nonce, request.username, password, 'notadmin'].join('\0')).digest('hex');
    attempted = true;
    created = await api('registration', '/_synapse/admin/v1/register', {
      nonce, username: request.username, password, displayname: request.name, admin: false, inhibit_login: true, mac,
    });
  } else {
    attempted = true;
    created = await api('registration', userPath, { password, displayname: request.name, admin: false });
  }
  // No login, access token, bot registry entry or connector-access grant is made.
  if (created?.user_id !== userId && created?.name !== userId) throw new PublicError('The server did not confirm the expected Matrix ID. The account may have been created; check the server and data/created-users.');
  // Keep the recovery password intact if updating the outcome fails midway.
  const temporary = record + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify({ userId, name: request.name, password, homeserver: config.homeserver, status: 'created', createdAt: new Date().toISOString() }, null, 2), { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, record);
  } catch (cause) {
    throw new PublicError('The Matrix user was created, but its local status could not be updated. The recovery password remains in data/created-users on the connector host. Do not repeat account creation.', { cause });
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* Preserve the creation outcome and original persistence error. */ }
  }
  return `**Matrix user created:** ${markdownText(request.name)}\n\nServer: ${inlineCode(config.homeserver)}\nMatrix ID: ${inlineCode(userId)}\nPassword: ${inlineCode(password)}\n\nSign in through Element X and change the password in account settings. To grant bot access separately: ${inlineCode('allow ' + userId)}.`;
}
