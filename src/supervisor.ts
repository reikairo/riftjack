import { errorMessage } from './errors.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CONFIG_EXIT_CODE, RESTART_EXIT_CODE, SUPERVISOR_RESTART_EXIT_CODE } from './restart.js';
import { RestartNotice, type RestartTarget } from './restart-notice.js';
import { CodeHistory, type Snapshot } from './history.js';

// Messages sent by main.ts over the IPC channel.
export type SupervisorMessage = { type: 'connector-config'; dataDir: string } | { type: 'connector-ready' };

type Options = {
  args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv;
  // Without history, crashes are still restarted but nothing is snapshotted or rolled back.
  history?: CodeHistory;
  // How long a ready connector must keep running before its code counts as working.
  stableMs?: number;
  retryMs?: (failures: number) => number;
  log?: (message: string) => void;
  // On !restart, replaces this supervisor with a fresh one if its own code changed.
  upgrade?: { changed: () => boolean; args: string[] };
};

// Modules loaded by the supervisor process itself; main.ts reloads everything else on !restart.
const SUPERVISOR_MODULES = ['supervisor.ts', 'restart.ts', 'restart-notice.ts', 'history.ts', 'errors.ts'];
export function supervisorCodeHash(dir = dirname(fileURLToPath(import.meta.url))): string {
  const hash = createHash('sha256');
  for (const file of SUPERVISOR_MODULES) {
    try { hash.update(file + '\0').update(readFileSync(join(dir, file))).update('\0'); } catch { hash.update(file + '\0missing\0'); }
  }
  return hash.digest('hex');
}

function rollbackMessage(afterRestart: boolean, snapshot: string, failed: string): string {
  return `Automatic rollback: the connector crashed while starting${afterRestart ? ' after your restart' : ''}, so the last working version (${snapshot}) was restored. ` +
    `The failed code was saved to ${failed}. Dependencies in node_modules were not changed.`;
}

// Keep .env out of the supervisor: each replacement child must load its current contents.
// The working directory is the instance directory (.env, data/); the code may live elsewhere,
// so tsx is resolved from the code rather than from the working directory.
export async function supervise(options: Options = {}): Promise<number> {
  const cwd = options.cwd || process.cwd();
  const args = options.args || ['--env-file-if-exists=.env', '--import', fileURLToPath(import.meta.resolve('tsx')), fileURLToPath(new URL('./main.ts', import.meta.url))];
  const stableMs = options.stableMs ?? 30_000;
  const retryMs = options.retryMs ?? (failures => Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6)));
  const log = options.log ?? (message => console.log(message));
  let child: ChildProcess | undefined;
  // A replacement supervisor stops its own connector; killing it early would orphan that connector.
  let childIsSupervisor = false;
  let stopping = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  // Replaced by the child's report; matches main.ts's default until then.
  let dataDir = resolve(cwd, 'data');
  // The owner awaiting the outcome of !restart, until a new connector proves stable.
  let requester: RestartTarget | undefined;
  let failures = 0;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    wake?.();
    child?.kill(signal);
    killTimer = setTimeout(() => { if (!childIsSupervisor) child?.kill('SIGKILL'); }, 10_000);
    killTimer.unref();
  };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const healthy = (snapshot: Snapshot | undefined) => {
    requester = undefined; failures = 0;
    try {
      const saved = snapshot && options.history?.promote(snapshot);
      if (saved) log(`Saved working connector version ${saved}.`);
    } catch (error) { log(errorMessage(error, 'Could not save a snapshot of the working connector version. Check disk space and permissions.')); }
  };
  try {
    while (!stopping) {
      let candidate: Snapshot | undefined;
      try { candidate = options.history?.capture(); }
      catch (error) { log(errorMessage(error, 'Could not capture the launch version. This run will not create a working snapshot.')); }
      let stable = false;
      let stableTimer: ReturnType<typeof setTimeout> | undefined;
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child = spawn(process.execPath, args, {
          cwd,
          env: { ...(options.env || process.env), MATRIX_CONNECTOR_SUPERVISED: '1',
            MATRIX_CONNECTOR_SUPERVISOR_RESTART: options.upgrade ? '1' : '0' },
          stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        });
        child.on('message', (message: SupervisorMessage) => {
          if (message?.type === 'connector-config' && typeof message.dataDir === 'string') dataDir = message.dataDir;
          if (message?.type === 'connector-ready' && !stableTimer) {
            // Changes during startup may have affected module loading. Do not certify that run.
            if (candidate && options.history) {
              try {
                if (options.history.hash() !== candidate.hash) {
                  options.history.discard(candidate); candidate = undefined;
                  log('Code changed during startup; no working snapshot will be saved for this run.');
                }
              } catch {
                try { if (candidate) options.history.discard(candidate); } catch {}
                candidate = undefined; log('Could not verify the launch version; no working snapshot will be saved.');
              }
            }
            stableTimer = setTimeout(() => { stable = true; healthy(candidate); }, stableMs);
          }
        });
        child.once('error', reject);
        // 'close' guarantees that the old process has exited and released its crypto databases.
        child.once('close', (code, signal) => { clearTimeout(stableTimer); resolve({ code, signal }); });
      }).finally(() => {
        try { if (candidate) options.history?.discard(candidate); }
        catch (error) { log(errorMessage(error, 'Could not remove the pending launch snapshot. Check disk space and permissions.')); }
      });
      child = undefined;
      if (stopping) return 0;
      if ((result.code === RESTART_EXIT_CODE || result.code === SUPERVISOR_RESTART_EXIT_CODE) && !result.signal) {
        // The child saved the requester's destination just before exiting.
        try { requester = new RestartNotice(join(dataDir, 'restart-notice.json')).target() ?? requester; } catch {}
        let upgrade = false;
        try { upgrade = !!options.upgrade?.changed(); } catch {}
        if (result.code === SUPERVISOR_RESTART_EXIT_CODE && options.upgrade) upgrade = true;
        if (upgrade) {
          // Node cannot replace its own process image. The fresh supervisor runs as a child and this
          // process only forwards signals, so the PID, terminal and log file stay the same.
          log('Starting a fresh supervisor…');
          childIsSupervisor = true;
          const next = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            child = spawn(process.execPath, options.upgrade!.args, { cwd, env: options.env || process.env, stdio: 'inherit' });
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
          });
          child = undefined;
          return next.code ?? 1;
        }
        console.log('Restarting connector…');
        continue;
      }
      if (!result.signal && (result.code === 0 || result.code === CONFIG_EXIT_CODE)) return result.code;
      failures = stable ? 1 : failures + 1;
      if (!stable && options.history) {
        try {
          const rolled = options.history.rollback();
          if (rolled) {
            log(`Connector failed during startup. Rolled back to ${rolled.snapshot}; failed code saved to ${rolled.failed}.`);
            const notice = new RestartNotice(join(dataDir, 'restart-notice.json'));
            // Without a !restart requester, keep any undelivered notice's destination, else use the manager DM.
            let target = requester;
            if (!target) { try { target = notice.target(); } catch {} }
            notice.save(target, rollbackMessage(!!requester, rolled.snapshot, rolled.failed));
          }
        } catch (error) { log(errorMessage(error, 'Automatic rollback failed. Check .connector-history and restore the code manually.')); }
      }
      const delay = retryMs(failures);
      log(`Connector exited unexpectedly (${result.signal || 'code ' + result.code}). Restarting in ${delay / 1000}s.`);
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, delay);
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = undefined;
    }
    return 0;
  } finally {
    if (killTimer) clearTimeout(killTimer);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const started = supervisorCodeHash();
  supervise({
    // Snapshots belong to this instance, next to its .env and data/, not inside the code repository.
    history: new CodeHistory(root, resolve('.connector-history')),
    upgrade: { changed: () => supervisorCodeHash() !== started, args: [...process.execArgv, ...process.argv.slice(1)] },
  }).then(code => { process.exitCode = code; }).catch(error => {
    console.error(errorMessage(error, 'Could not launch the connector process. Check the Node executable and connector files.'));
    process.exitCode = 1;
  });
}
