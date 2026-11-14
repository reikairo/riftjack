import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { PublicError } from './errors.js';
import { readOutgoing } from './media.js';
import { diagramSource } from './drawio-source.js';
import { embedDiagram, extractDiagram, MAX_PNG } from './drawio-png.js';
import type { ToolAction } from './tool-mcp.js';

export type DrawioConfig = { executable: string };
export function drawioOutsideWorkspace(config: DrawioConfig, workspace: string) {
  if (config.executable.startsWith(workspace + sep)) throw new Error('DRAWIO_PATH must be outside every agent workspace.');
}
export function loadDrawioConfig(env: NodeJS.ProcessEnv, workspace: string): DrawioConfig | undefined {
  const value = env.DRAWIO_PATH?.trim();
  if (!value) return undefined;
  if (process.platform === 'win32') throw new Error('The draw.io tool currently supports macOS and Linux.');
  if (!isAbsolute(value)) throw new Error('DRAWIO_PATH must be an absolute executable path.');
  const executable = realpathSync(value);
  if (!statSync(executable).isFile()) throw new Error('DRAWIO_PATH must be a regular executable file.');
  accessSync(executable, constants.X_OK);
  const config = { executable };
  drawioOutsideWorkspace(config, workspace);
  return config;
}

export type Renderer = (executable: string, directory: string, signal: AbortSignal) => Promise<void>;
// A dedicated profile keeps this export separate from an interactive editor. No
// shell, connector credentials, plugins or user profile are inherited.
export const renderDrawio: Renderer = async (executable, directory, signal) => {
  signal.throwIfAborted();
  const home = join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {};
  // macOS Electron needs the real HOME to finish startup. The separate
  // --user-data-dir below isolates draw.io settings without replacing HOME.
  for (const key of ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'DISPLAY', 'XAUTHORITY']) if (process.env[key]) env[key] = process.env[key];
  const common = [`--user-data-dir=${join(home, 'profile')}`, '--disable-gpu', '--disable-background-networking',
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
    '--export', '--border', '10'];
  const run = async (format: 'svg' | 'png', dimensions: string[] = []) => {
    signal.throwIfAborted();
    const target = join(directory, 'render.' + format);
    const args = [...common, '--format', format, ...dimensions, '--output', target, join(directory, 'input.drawio')];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { cwd: directory, env, detached: true, stdio: 'ignore' });
      let failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (sig: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.kill(-child.pid, sig); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= new PublicError('Could not stop draw.io.', { cause: e }); }
      };
      const stop = (error: Error) => {
        if (failure) return;
        failure = error; kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 1000);
      };
      const abort = () => stop(new PublicError('Diagram rendering cancelled or timed out.'));
      signal.addEventListener('abort', abort, { once: true });
      const sizeTimer = setInterval(() => { void stat(target).then(s => {
        if (s.size > MAX_PNG) stop(new PublicError('Rendered PNG exceeds 32 MiB.'));
      }).catch(() => {}); }, 100);
      child.once('error', e => { failure = e; });
      child.once('close', (code, killed) => {
        clearInterval(sizeTimer); clearTimeout(killTimer); signal.removeEventListener('abort', abort);
        // Also reap helpers left by a failed/aborted Electron parent before cleanup.
        kill('SIGKILL');
        if (failure) reject(failure);
        else if (code !== 0 || killed) reject(new PublicError('draw.io export failed. Check the configured desktop executable and display on the host.', { cause: { code, signal: killed } }));
        else resolve();
      });
      if (signal.aborted) abort();
    });
  };
  // Desktop treats height as an override, not a second bounding dimension.
  // Measure a vector export first, then constrain only the longer side.
  await run('svg');
  const svg = await readOutgoing({ root: directory, path: join(directory, 'render.svg') }, MAX_PNG);
  const header = /<svg\b[^>]*>/.exec(svg.toString('utf8'))?.[0] ?? '';
  const width = Number(/\bwidth="([0-9.]+)(?:px)?"/.exec(header)?.[1]);
  const height = Number(/\bheight="([0-9.]+)(?:px)?"/.exec(header)?.[1]);
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height)) throw new PublicError('Could not determine diagram dimensions.');
  await run('png', [width >= height ? '--width' : '--height', '2048']);
};

// Shared across all conversations/backends in this connector process. Refuse
// overlap instead of holding an unbounded queue of multi-megabyte XML requests.
let rendering = false;
export function diagramDirectory(workspace: string): string { return join(workspace, 'diagrams'); }

export function drawioAction(config: DrawioConfig, workspace: string, maxMediaBytes: number, renderer: Renderer = renderDrawio): ToolAction {
  const directory = diagramDirectory(workspace);
  const resolvePath = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new PublicError('Supply a nonempty diagram path.');
    const path = resolve(directory, value), rel = relative(workspace, path);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new PublicError('Diagram paths must be inside the configured workspace.');
    return path;
  };
  return async (input, signal) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PublicError('Expected a diagram request.');
    const p = input as Record<string, unknown>;
    const allowed = p.action === 'render' ? ['action', 'xml', 'page', 'out_path'] : p.action === 'extract' ? ['action', 'path', 'out_path'] : [];
    if (!allowed.length || Object.keys(p).some(k => !allowed.includes(k))) throw new PublicError('Use render_diagram with xml and optional page, or extract_diagram with a PNG path. Both accept an optional out_path.');
    signal.throwIfAborted();
    if (await realpath(workspace) !== workspace) throw new PublicError('Diagram workspace must not be a symlink.');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== directory) throw new PublicError('Diagram directory must not be a symlink.');
    let output: string | undefined;
    const checkParent = async (path: string) => {
      const parent = dirname(path);
      let canonical: string;
      try { canonical = await realpath(parent); }
      catch (cause) { throw new PublicError('The output parent directory must already exist.', { cause }); }
      if (canonical !== parent) throw new PublicError('Output directory symlinks are not allowed.');
    };
    if (p.out_path !== undefined) {
      const target = resolvePath(p.out_path);
      await checkParent(target);
      // Fail before invoking the renderer; exclusive creation below also covers
      // a competing writer that creates the path after this check.
      let exists = false;
      try { await lstat(target); exists = true; }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
      if (exists) throw new PublicError('The output file already exists. Choose a different out_path.');
      output = target;
    }
    signal.throwIfAborted();
    const save = async (data: Buffer | string, extension: string, metadata: object) => {
      signal.throwIfAborted();
      if (Buffer.byteLength(data) > maxMediaBytes) throw new PublicError('Result exceeds the configured attachment size limit.');
      const path = output ?? join(directory, 'diagram-' + randomUUID() + extension);
      if (await realpath(workspace) !== workspace) throw new PublicError('Diagram workspace must not be a symlink.');
      await checkParent(path);
      signal.throwIfAborted();
      try { await writeFile(path, data, { flag: 'wx', mode: 0o600 }); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new PublicError('The output file already exists. Choose a different out_path.', { cause });
        throw cause;
      }
      return JSON.stringify({ path, bytes: Buffer.byteLength(data), ...metadata });
    };
    if (p.action === 'extract') {
      const file = { root: workspace, path: resolvePath(p.path) };
      const xml = extractDiagram(await readOutgoing(file, MAX_PNG));
      return save(xml, '.drawio', { untrusted: true });
    }
    if (typeof p.xml !== 'string' || (p.page !== undefined && typeof p.page !== 'number')) throw new PublicError('Supply XML text and an optional integer page.');
    if (rendering) throw new PublicError('Another diagram is rendering. Retry after it completes.');
    const model = diagramSource(p.xml, p.page as number | undefined);
    rendering = true;
    let temporary: string | undefined;
    try {
      temporary = await realpath(await mkdtemp(join(tmpdir(), 'riftjack-drawio-')));
      await writeFile(join(temporary, 'input.drawio'), model.renderXml, { mode: 0o600, flag: 'wx' });
      const lifetime = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
      await renderer(config.executable, temporary, lifetime);
      lifetime.throwIfAborted();
      const rendered = await readOutgoing({ root: temporary, path: join(temporary, 'render.png') }, MAX_PNG);
      const png = embedDiagram(rendered, p.xml);
      if (png.readUInt32BE(16) > 2048 || png.readUInt32BE(20) > 2048) throw new PublicError('Rendered diagram exceeds 2048 pixels per side.');
      if (extractDiagram(png) !== p.xml) throw new PublicError('Embedded diagram source did not round-trip.');
      return await save(png, '.png', { page: model.page, pages: model.pages, editable: true });
    } finally {
      try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
      finally { rendering = false; }
    }
  };
}
