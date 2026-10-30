import type { BackendHooks } from './bridge.js';
import type { Config } from './config.js';
import { backendCapabilities, type CodingBackend } from './backend-capabilities.js';
import { startDetachedMcp, DETACHED_SERVER, detachedInstructions } from './detached-mcp.js';
import { startConfirmationMcp, CONFIRMATION_SERVER, confirmationInstructions } from './confirmation-mcp.js';
import { startGitHubMcp, GITHUB_SERVER, githubInstructions } from './github-mcp.js';
import { startBackgroundMcp, BACKGROUND_SERVER, backgroundInstructions } from './background-mcp.js';
import { startPublishMcp, PUBLISH_SERVER, publicationInstructions, type PublishAction } from './publish-mcp.js';
import { startAttachmentMcp, ATTACHMENT_SERVER } from './attachment-mcp.js';
import { attachmentDelivery } from './attachment-delivery.js';
import { startRoomMessageMcp, ROOM_MESSAGE_SERVER, roomMessageInstructions } from './room-message-mcp.js';
import { startFetchMcp, FETCH_SERVER, fetchInstructions } from './fetch-mcp.js';
import { fetchAction } from './fetch.js';
import { startDrawioMcp, DRAWIO_SERVER, drawioInstructions } from './drawio-mcp.js';
import { drawioAction } from './drawio.js';

type Connection = Awaited<ReturnType<typeof startBackgroundMcp>>;
// All backends use the same permission gates and cleanup. Only conversion of
// these endpoints into each CLI's configuration belongs to the individual adapter.
export async function startBackendTools(options: {
  kind: CodingBackend; config: Config; outbox: string; signal: AbortSignal;
  hooks?: BackendHooks; publish?: PublishAction; allowPublication: boolean; beforeAttachments?: () => Promise<void>;
}) {
  const { kind, config, outbox, signal, hooks, publish } = options;
  const connections: (Connection & { name: string })[] = [];
  const close = async () => { await Promise.allSettled(connections.splice(0).map(c => c.close())); };
  const add = async (name: string, operation: Promise<Connection>) => {
    const connection = await operation; connections.push({ name, ...connection }); signal.throwIfAborted(); return connection;
  };
  const supports = (tool: string) => backendCapabilities(kind).includes(tool);
  try {
    signal.throwIfAborted();
    const detached = supports('run_detached') && hooks?.detached && config.sandbox !== 'read-only'
      ? await add(DETACHED_SERVER, startDetachedMcp(hooks.detached, signal)) : undefined;
    const confirmation = supports('request_confirmation') && hooks?.confirmation
      ? await add(CONFIRMATION_SERVER, startConfirmationMcp(hooks.confirmation, signal)) : undefined;
    const github = hooks?.github ? await add(GITHUB_SERVER, startGitHubMcp(hooks.github, signal)) : undefined;
    const background = hooks?.background ? await add(BACKGROUND_SERVER, startBackgroundMcp(hooks.background, signal)) : undefined;
    const web = supports('fetch') && config.fetch && config.sandbox !== 'read-only'
      ? await add(FETCH_SERVER, startFetchMcp(fetchAction(config.fetch, config.workspace), signal)) : undefined;
    const publication = publish && options.allowPublication && config.sandbox !== 'read-only'
      ? await add(PUBLISH_SERVER, startPublishMcp(publish, signal)) : undefined;
    const diagram = supports('drawio') && config.drawio && config.sandbox !== 'read-only'
      ? await add(DRAWIO_SERVER, startDrawioMcp(drawioAction(config.drawio, outbox, config.maxMediaBytes), signal)) : undefined;
    const rooms = hooks?.roomMessages ? await add(ROOM_MESSAGE_SERVER, startRoomMessageMcp((input, s) => hooks.roomMessages!(input, s, outbox), signal)) : undefined;
    const delivery = hooks?.sendAttachments ? attachmentDelivery(outbox, config.maxMediaBytes, async (files, s) => {
      await options.beforeAttachments?.(); s.throwIfAborted(); return hooks.sendAttachments!(files, s);
    }, hooks.deliveryReceipts) : undefined;
    const media = delivery ? await add(ATTACHMENT_SERVER, startAttachmentMcp(delivery.action, signal)) : undefined;
    const instructions = (detached ? detachedInstructions : '') + (confirmation ? confirmationInstructions : '') +
      (publication ? publicationInstructions : '') + (github ? githubInstructions : '') + (background ? backgroundInstructions : '') +
      (rooms ? roomMessageInstructions : '') + (web && config.fetch ? fetchInstructions(config.fetch.allow.map(p => p.text)) : '') +
      (diagram ? drawioInstructions : '');
    return { detached, confirmation, github, background, web, publication, diagram, rooms, delivery, media, instructions, connections, close };
  } catch (error) { await close(); throw error; }
}
