import { MAX_ATTACHMENTS } from './media.js';
import { startToolMcp, type ToolAction } from './tool-mcp.js';

export const ATTACHMENT_SERVER = 'riftjack_attachments';
export const ATTACHMENT_TOOL = 'mcp__riftjack_attachments__send_attachments';

export function startAttachmentMcp(action: ToolAction, signal: AbortSignal) {
  return startToolMcp({
    name: 'send_attachments',
    description: 'Send ready files from this turn\'s outbox to the current Matrix conversation immediately, without ending the turn. Supply a unique id with files. Returns per-file delivery status saved across turns and restarts. action=status with id retrieves the saved receipt; omit id to list recent deliveries. Reuse the same id only with identical content; uncertain sends are never retried. Repeated paths return the previous status without resending during this turn. Never automatically resend an uncertain delivery or include attempted files in the final manifest.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['status'] },
      id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$', description: 'Required for sending. Keep the same id to retrieve a lost result without sending again.' },
      files: { type: 'array', minItems: 1, maxItems: MAX_ATTACHMENTS, items: {
        type: 'object', additionalProperties: false, required: ['path'], properties: {
          path: { type: 'string', description: 'Path relative to the current conversation outbox.' },
          name: { type: 'string', description: 'Optional display filename.' },
        },
      } },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, action, signal, { server: ATTACHMENT_SERVER,
    cancelled: 'Attachment delivery cancelled. Some files may have been sent. Inspect the conversation before retrying; repeating paths during this turn only returns their previous status.',
    failed: 'Attachment delivery failed. Some files may have been sent. Inspect the conversation before retrying.',
  });
}
