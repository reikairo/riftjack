export type CodingBackend = 'codex' | 'claude' | 'pi';
const shared = ['background_tasks', 'github_subscriptions', 'room_messages', 'send_attachments', 'prepare_publish'] as const;
export function backendCapabilities(kind: CodingBackend): readonly string[] {
  return kind === 'pi' ? [...shared] : [...shared, 'run_detached', 'request_confirmation', 'fetch', 'drawio'];
}
