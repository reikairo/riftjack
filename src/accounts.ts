import { type EngineSettings, validateEngineSettings } from './engine-settings.js';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './config.js';
import type { Mode } from './bridge.js';
import { PublicError, safeErrorSummary, connectionHint } from './errors.js';
export { PublicError } from './errors.js';

export type Account = { userId: string; accessToken: string; kind: Mode; name: string; roomId?: string; inviteUserId?: string; workspace?: string; engineSettings?: EngineSettings };

export class Accounts {
  private accounts: Account[];
  constructor(private file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.accounts = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    if (!Array.isArray(this.accounts) || this.accounts.some(a =>
      !/^@[^\s:]+:[^\s]+$/.test(a.userId) || typeof a.accessToken !== 'string' || !a.accessToken ||
      typeof a.name !== 'string' || !['codex', 'claude', 'pi', 'grok', 'manager'].includes(a.kind) ||
      (a.workspace !== undefined && (typeof a.workspace !== 'string' || !a.workspace || /[\0\r\n]/.test(a.workspace))))) throw new Error('Invalid accounts.json: expected valid bot accounts and optional workspace paths.');
    for (const account of this.accounts) if (account.engineSettings !== undefined) validateEngineSettings(account.engineSettings, account.kind);
    if (new Set(this.accounts.map(a => a.userId)).size !== this.accounts.length) throw new Error('Duplicate bot accounts in accounts.json');
  }
  list(): Account[] { return this.accounts.map(a => ({ ...a, ...(a.engineSettings ? { engineSettings: { ...a.engineSettings } } : {}) })); }
  add(account: Account) { this.accounts.push(account); this.save(); }
  setEngineSettings(userId: string, settings: EngineSettings) {
    const account = this.accounts.find(a => a.userId === userId);
    if (!account) throw new PublicError('Bot account not found.');
    validateEngineSettings(settings, account.kind);
    const updated = this.accounts.map(a => a === account ? { ...a, engineSettings: { ...settings } } : a);
    writeFileSync(`${this.file}.tmp`, JSON.stringify(updated, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
    this.accounts = updated;
  }
  setName(userId: string, name: string) {
    const account = this.accounts.find(a => a.userId === userId);
    if (!account) throw new PublicError('Bot account not found.');
    account.name = name;
    this.save();
  }
  setRoom(userId: string, roomId: string) {
    this.accounts.find(a => a.userId === userId)!.roomId = roomId;
    this.save();
  }
  private save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.accounts, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}

export async function provision(config: Config, kind: Mode, name: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<Account> {
  if (kind !== 'codex' && kind !== 'claude' && kind !== 'pi' && kind !== 'grok' && kind !== 'manager') throw new PublicError('Only Codex, Claude, Pi, Grok and manager bots are supported.');
  if (!config.registrationSecret && !config.adminToken) throw new PublicError('Account creation is not configured. Set SYNAPSE_ADMIN_TOKEN or SYNAPSE_REGISTRATION_SHARED_SECRET in the connector .env.');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || kind;
  const username = `bot_${kind}_${slug}_${randomBytes(6).toString('hex')}`;
  const password = randomBytes(32).toString('base64url');
  let accountMayExist = false;
  const request = async (step: string, path: string, body?: object, token?: string, allow404 = false) => {
    const isAdmin = path.startsWith('/_synapse/admin/');
    const baseUrl = isAdmin ? config.adminUrl : config.homeserver;
    const endpoint = isAdmin ? 'Synapse Admin API' : 'Matrix Client API';
    const url = new URL(baseUrl);
    const tunnel = isAdmin && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ? ` Check the SSH tunnel or local Synapse listener at ${url.host}; keep it running while creating bots.` : '';
    const fail = (reason: string) => new PublicError(`Bot setup failed at step "${step}". ${endpoint} (${url.origin}): ${reason}` +
      (accountMayExist ? ' The account may already exist on Synapse. Check server accounts before retrying; this attempt was not saved in the connector.' : ''));
    const requestSignal = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    signal?.throwIfAborted();
    if (step === 'create account' || step === 'register account') accountMayExist = true;
    let response: Response;
    try {
      response = await fetcher(baseUrl + path, {
        method: body ? (path.startsWith('/_synapse/admin/v2/users/') ? 'PUT' : 'POST') : 'GET',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error', signal: requestSignal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      const details = safeErrorSummary(requestSignal.aborted ? requestSignal.reason : error);
      throw fail(`${details}. ${connectionHint(details)}${tunnel}`);
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      let matrixCode = '';
      try {
        const body = await response.json() as { errcode?: unknown } | null;
        const detail = safeErrorSummary({ errcode: body?.errcode });
        if (detail.startsWith('M_')) matrixCode = `, ${detail}`;
      } catch { signal?.throwIfAborted(); }
      const hint = response.status === 401 || response.status === 403
        ? 'Check admin credentials and permissions, or password-login support if this is the new bot login. Servers using Matrix Authentication Service need a different provisioning adapter.'
        : response.status === 404 ? 'Check the endpoint and reverse proxy routing to Synapse.'
        : response.status === 429 ? 'The server is rate limiting requests. Wait before retrying.'
        : 'Check Synapse availability and server logs.';
      throw fail(`HTTP ${response.status}${matrixCode}. ${hint}`);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      signal?.throwIfAborted();
      if (requestSignal.aborted || !(error instanceof SyntaxError)) {
        const details = safeErrorSummary(requestSignal.aborted ? requestSignal.reason : error);
        throw fail(`Response could not be read: ${details}. ${connectionHint(details)}${tunnel}`);
      }
      throw fail('Returned an empty or non-JSON response. Check the reverse proxy routing to Synapse.');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('Returned an invalid JSON object. Check the reverse proxy routing to Synapse.');
    return data as Record<string, unknown>;
  };
  let login: Record<string, unknown> | null;
  if (config.registrationSecret) {
    const nonceResponse = await request('get registration nonce', '/_synapse/admin/v1/register');
    const nonce = nonceResponse?.nonce;
    if (typeof nonce !== 'string') throw new PublicError('Synapse did not return a registration nonce.');
    const mac = createHmac('sha1', config.registrationSecret).update([nonce, username, password, 'notadmin'].join('\0')).digest('hex');
    login = await request('register account', '/_synapse/admin/v1/register', { nonce, username, password, admin: false, displayname: name, mac });
  } else {
    const admin = await request('verify admin identity', '/_matrix/client/v3/account/whoami', undefined, config.adminToken);
    if (typeof admin?.user_id !== 'string' || !admin.user_id.includes(':')) throw new PublicError('Could not determine the server name from the admin account.');
    const userId = `@${username}:${admin.user_id.slice(admin.user_id.indexOf(':') + 1)}`;
    const path = '/_synapse/admin/v2/users/' + encodeURIComponent(userId);
    // Random names plus an existence check avoid modifying any existing account.
    if (await request('check account availability', path, undefined, config.adminToken, true)) throw new PublicError('Generated account name already exists. Try again.');
    await request('create account', path, { password, displayname: name, admin: false }, config.adminToken);
    login = await request('log in new bot', '/_matrix/client/v3/login', {
      type: 'm.login.password', identifier: { type: 'm.id.user', user: userId }, password,
      initial_device_display_name: 'Matrix connector',
    });
  }
  if (typeof login?.user_id !== 'string' || typeof login.access_token !== 'string' || typeof login.device_id !== 'string') {
    throw new PublicError('Bot setup failed at step "validate bot login": registration/login did not return a device-bound bot session. Check homeserver authentication settings. The account may already exist on Synapse; check server accounts before retrying. This attempt was not saved in the connector.');
  }
  return { userId: login.user_id, accessToken: login.access_token, kind, name };
}

export type ManagerRequest = { action: 'list' } | { action: 'create'; kind: 'codex' | 'claude' | 'pi' | 'grok'; name: string; workspace?: string };
export function parseManagerRequest(text: string): ManagerRequest | null {
  const input = text.trim();
  // Keep quoted paths intact; otherwise the last spaced "in" separates the path.
  const directory = /^(.*)\s+in\s+("(?:[^"\\]|\\.)*"|'[^']*')$/i.exec(input)
    ?? /^(.*)\s+in\s+([^\r\n]+)$/i.exec(input);
  let workspace: string | undefined;
  if (directory) {
    const raw = directory[2].trim();
    if (raw.startsWith("'") && !/^'[^']*'$/.test(raw)) return null;
    try { workspace = raw.startsWith('"') ? JSON.parse(raw) : raw.startsWith("'") ? raw.slice(1, -1) : raw; }
    catch { return null; }
    if (!workspace || /[\0\r\n]/.test(workspace)) return null;
  }
  const clean = (directory ? directory[1] : input).trim().replace(/[.!?]+$/, '');
  if (/^(?:please\s+)?(?:list(?:\s+(?:my|the|all))?\s+bots|show(?:\s+me)?(?:\s+(?:my|the|all))?\s+bots|list)$/i.test(clean)) return directory ? null : { action: 'list' };
  const match = /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:create|make|add)\s+(?:(?:me|a|an|another|new|one|more)\s+)*(codex|claude(?:\s+code)?|pi(?:\s+code)?|grok)(?:\s+bot)?(?:\s+(?:named|called)\s+([a-z0-9][a-z0-9 _-]{0,47}))?$/i.exec(clean);
  if (!match) return null;
  const kind = /^pi(?:\s+code)?$/i.test(match[1]) ? 'pi' : match[1].toLowerCase() === 'codex' ? 'codex' : match[1].toLowerCase() === 'grok' ? 'grok' : 'claude';
  return { action: 'create', kind, name: match[2]?.trim() || (kind === 'pi' ? 'Pi' : kind === 'codex' ? 'Codex' : kind === 'grok' ? 'Grok' : 'Claude'), ...(workspace === undefined ? {} : { workspace }) };
}
