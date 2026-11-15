import { PublicError } from './accounts.js';
import type { AppServer } from './app-server.js';
import type { Interact } from './interactions.js';

type App = { name: string; installUrl?: string | null };
type Plugin = {
  marketplaceName: string; description?: string | null; apps: App[]; mcpServers: string[];
  summary: { name: string; installed: boolean; installPolicy: string; availability: string };
};

function authentication(apps: App[]): string {
  if (!apps.length) return '';
  return '\nBrowser authentication is still required. Open the service links yourself; do not send passwords or tokens to the bot:\n' + apps.map(app => {
    try {
      const url = new URL(app.installUrl || '');
      if (url.protocol === 'https:' && !url.username && !url.password) return `${app.name}: ${url.href}`;
    } catch { /* No usable link was supplied by the service. */ }
    return `${app.name}: no login link provided; connect it in the host application's plugin settings.`;
  }).join('\n');
}

// This is a local Matrix command, not an agent-interpreted prompt. Only the owner
// may change account-wide plugins, and only the official remote catalog is used.
export async function installPlugin(server: AppServer, name: string, signal: AbortSignal, interact: Interact): Promise<string> {
  const params = { pluginName: name, remoteMarketplaceName: 'openai-curated-remote' };
  const { plugin } = await server.request<{ plugin: Plugin }>('plugin/read', params);
  signal.throwIfAborted();
  if (plugin.marketplaceName !== params.remoteMarketplaceName || plugin.summary.name !== name) throw new PublicError('The plugin catalog returned a different plugin or marketplace. Installation stopped.');
  if (plugin.summary.installed) return `Plugin ${name} is already installed. No installation was repeated. Check its connection in the host application's plugin settings.`;
  const choice = await interact({
    text: `Install Codex plugin: ${name}\nMarketplace: ${params.remoteMarketplaceName}\n${plugin.description || ''}\nApps: ${plugin.apps.map(app => app.name).join(', ') || 'none'}\nMCP servers: ${plugin.mcpServers.join(', ') || 'none'}\nThis changes the shared Codex account/host. The service will enforce its installation policy; browser login may still be required.`,
    approve: { install: true }, deny: { install: false },
  }, signal);
  signal.throwIfAborted();
  if (!('install' in choice) || choice.install !== true) return `Installation of ${name} was declined.`;
  // Never retry automatically: a timeout can occur after the server committed an install.
  let result: { appsNeedingAuth: App[] };
  try { result = await server.request('plugin/install', params, 120_000); }
  catch (error) {
    signal.throwIfAborted();
    throw new PublicError('Plugin installation was not confirmed. Check the plugin state in the host application before retrying; it may have partially completed.', { cause: error });
  }
  signal.throwIfAborted();
  return `Plugin ${name} was installed.${authentication(result.appsNeedingAuth)}\nSend your next request after any required authentication.`;
}
