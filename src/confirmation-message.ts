import { replyContent } from './message-format.js';
import type { ReactionControls } from './interactions.js';

export async function sendConfirmation(text: string, controls: ReactionControls, transport: {
  authorize: () => Promise<void>;
  sendMessage: (content: ReturnType<typeof replyContent>[number]) => Promise<string>;
  sendReaction: (eventId: string, key: string) => Promise<unknown>;
  report: (error: unknown) => void;
}, markdown?: string): Promise<void> {
  let lastId: string | undefined;
  // The request size is checked before formatting. Escaping may expand the
  // source beyond the normal reply limit; confirmations must never truncate.
  for (const part of replyContent(markdown ?? text, markdown !== undefined, false, 'm.text', true)) {
    if (!controls.isPending()) return;
    await transport.authorize();
    if (!controls.isPending()) return;
    lastId = await transport.sendMessage(part);
  }
  // Only a fully delivered request can be answered through its last message.
  if (!lastId || !controls.isPending()) return;
  controls.bind(lastId);
  for (const key of controls.keys) {
    // A manual answer may arrive while the previous seed waits out a 429.
    // Do not start another authorization request after the decision is final.
    if (!controls.isPending()) return;
    await transport.authorize();
    if (!controls.isPending()) return;
    try { await transport.sendReaction(lastId, key); }
    catch (error) { transport.report(error); } // Commands/manual reactions still work.
  }
}
