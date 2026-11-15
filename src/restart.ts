import { PublicError } from './accounts.js';
import type { RestartNotice, RestartTarget } from './restart-notice.js';

export const RESTART_EXIT_CODE = 75;
export const SUPERVISOR_RESTART_EXIT_CODE = 76;
export type RestartScope = 'connector' | 'supervisor';
// Invalid .env: restarting cannot help, so the supervisor stops instead of looping.
export const CONFIG_EXIT_CODE = 78;

export class RestartController {
  private requested = false;
  constructor(private options: { supported: boolean; supervisorSupported?: boolean; busy: () => boolean; shutdown: (code: number) => void; notice?: RestartNotice }) {}
  get pending(): boolean { return this.requested; }

  async request(reply: (text: string) => Promise<void>, target?: RestartTarget, scope: RestartScope = 'connector'): Promise<void> {
    if (!this.options.supported) throw new PublicError('Restart is unavailable for this launch. Start the connector with npm start on the host first.');
    if (scope === 'supervisor' && !this.options.supervisorSupported) throw new PublicError('The running supervisor does not support this command yet. Run riftjack/scripts/restart-supervisor.sh once in the host terminal, then use !restart supervisor here.');
    if (this.requested) throw new PublicError('The connector is already restarting.');
    if (this.options.busy()) throw new PublicError('A bot is busy or starting up. Wait for it to finish, or send !cancel in its active conversation and retry !restart after it stops.');
    // Reserve the restart before awaiting the acknowledgement, blocking new tasks across all bots.
    this.requested = true;
    let saved = false;
    try {
      if (this.options.notice) {
        if (!target) throw new PublicError('Restart notification destination is missing. Restart was not performed.');
        try { this.options.notice.save(target); saved = true; }
        catch (cause) { throw new PublicError('Could not save the restart notification destination. Check data directory permissions and free disk space. Restart was not performed.', { cause }); }
      }
      await reply((scope === 'supervisor' ? 'Restarting the supervisor, connector and all bots. ' : 'Restarting the connector and all bots. ') +
        'Conversations and files will be preserved. Please wait a few seconds before sending another message.');
    } catch (error) {
      this.requested = false;
      if (saved) {
        try { this.options.notice!.clear(); }
        catch (cleanup) {
          // Keep this a diagnostic error: Bridge must not attempt another reply
          // after acknowledgement delivery has already failed.
          throw new AggregateError([error, cleanup], 'Restart was not performed; acknowledgement and notification cleanup failed.');
        }
      }
      throw error;
    }
    this.options.shutdown(scope === 'supervisor' ? SUPERVISOR_RESTART_EXIT_CODE : RESTART_EXIT_CODE);
  }
}
