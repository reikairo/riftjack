import { AppServer } from './app-server.js';
import type { Config } from './config.js';
import { PublicError } from './errors.js';
import { inlineCode } from './manager-format.js';

type Model = {
  model: string; isDefault: boolean; hidden?: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string }[];
  serviceTiers?: { id: string }[] | null; defaultServiceTier?: string | null;
};
type Page = { data: Model[]; nextCursor?: string | null };

// Discovery only. Never start a thread, submit a prompt, or change settings.
export async function codexModelOptions(config: Config, signal: AbortSignal): Promise<string> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  signal.throwIfAborted();
  const server = new AppServer(config, () => {}, () => {});
  const abort = () => { void server.close(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await server.initialize();
    const auth = await server.request<{ account?: { type: string } }>('account/read', { refreshToken: false });
    signal.throwIfAborted();
    if (auth.account?.type !== 'chatgpt') throw new PublicError('Sign in to Codex with ChatGPT on the host to list models.');
    const models: Model[] = [], cursors = new Set<string>();
    let cursor: string | undefined, pages = 0;
    do {
      const page = await server.request<Page>('model/list', { limit: 100, includeHidden: false, ...(cursor && { cursor }) });
      signal.throwIfAborted();
      if (!page || !Array.isArray(page.data) || (page.nextCursor != null && typeof page.nextCursor !== 'string')) throw new PublicError('Codex returned an invalid model catalog.');
      models.push(...page.data);
      if (++pages > 100 || models.length > 1000 || (page.nextCursor && cursors.has(page.nextCursor))) {
        throw new PublicError('Codex model catalog pagination did not complete; no partial list is shown.');
      }
      cursor = page.nextCursor || undefined;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const visible = models.filter(model => {
      if (!model || typeof model !== 'object') throw new PublicError('Codex returned an invalid model catalog.');
      return !model.hidden;
    });
    if (!visible.length) return 'Codex returned no selectable models. Check the account and CLI configuration on the host.';
    const lines = visible.map(model => {
      if (typeof model.model !== 'string' || typeof model.defaultReasoningEffort !== 'string' ||
          !Array.isArray(model.supportedReasoningEfforts) || model.supportedReasoningEfforts.some(e => !e || typeof e.reasoningEffort !== 'string') ||
          (model.serviceTiers != null && (!Array.isArray(model.serviceTiers) || model.serviceTiers.some(t => !t || typeof t.id !== 'string')))) {
        throw new PublicError('Codex returned an invalid model catalog.');
      }
      const efforts = model.supportedReasoningEfforts.map(e => inlineCode(e.reasoningEffort)).join(', ') || 'not reported';
      const tiers = model.serviceTiers?.map(t => inlineCode(t.id)).join(', ') || 'not reported by this CLI';
      return `- ${inlineCode(model.model)}${model.isDefault ? ' (catalog default)' : ''}${model.model === config.codexModel ? ' (configured)' : ''}: `
        + `reasoning: ${efforts}; default reasoning: ${inlineCode(model.defaultReasoningEffort)}; tier: ${tiers}`
        + (typeof model.defaultServiceTier === 'string' ? `; default tier: ${inlineCode(model.defaultServiceTier)}` : '') + '.';
    });
    return '### Models and reasoning levels reported by Codex\n\n' + lines.join('\n')
      + '\n\nThis is the installed CLI/account catalog, not a guarantee that every request will be accepted. No model turn was started.';
  } finally {
    signal.removeEventListener('abort', abort);
    await server.close();
  }
}
