import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { PublicError, errorMessage, safeErrorSummary } from './errors.js';

export type TunnelConfig = { target: string; port: number; localPort: number; remotePort: number; identity?: string };

export function loadTunnelConfig(env: NodeJS.ProcessEnv, adminUrl: URL): TunnelConfig | undefined {
  const target = env.SYNAPSE_SSH_TARGET?.trim();
  if (!target) return;
  if (!/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(target)) {
    throw new Error('SYNAPSE_SSH_TARGET must be an SSH host alias or user@hostname (no command-line flags).');
  }
  if (adminUrl.protocol !== 'http:' || adminUrl.hostname !== '127.0.0.1' || !adminUrl.port || adminUrl.pathname !== '/') {
    throw new Error('Automatic SSH tunnelling requires SYNAPSE_ADMIN_URL=http://127.0.0.1:PORT without a path.');
  }
  const port = (value: string | undefined, fallback: number, label: string) => {
    const parsed = value?.trim() ? Number(value) : fallback;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${label} must be a port between 1 and 65535.`);
    return parsed;
  };
  return { target, port: port(env.SYNAPSE_SSH_PORT, 22, 'SYNAPSE_SSH_PORT'), localPort: Number(adminUrl.port),
    remotePort: port(env.SYNAPSE_SSH_REMOTE_PORT, 8008, 'SYNAPSE_SSH_REMOTE_PORT'), identity: env.SYNAPSE_SSH_IDENTITY?.trim() || undefined };
}

export function tunnelArguments(config: TunnelConfig): string[] {
  return ['-N', '-T', '-v', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ForkAfterAuthentication=no',
    '-o', 'PermitLocalCommand=no', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
    '-p', String(config.port), ...(config.identity ? ['-i', config.identity] : []),
    '-L', `127.0.0.1:${config.localPort}:127.0.0.1:${config.remotePort}`, config.target];
}

function tunnelEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'SSH_AUTH_SOCK', 'SYSTEMROOT']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, LANG: 'C', LC_ALL: 'C' };
}

// OpenSSH runs in the foreground. Only known diagnostic categories are exposed;
// verbose SSH output (hostnames, key paths, banners, etc.) never goes to chat/logs.
export class SshTunnel {
  private child?: ChildProcess;
  private closed: Promise<void> = Promise.resolve();
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private ready = false;
  private attempts = 0;
  private problem = 'SSH connection is starting.';
  private onExit = () => { this.child?.kill('SIGTERM'); };

  constructor(private config: TunnelConfig, private options: {
    report: (message: string) => void; executable?: string; retryMs?: number; killMs?: number;
  }) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    process.once('exit', this.onExit);
    this.launch();
  }

  private launch(): void {
    if (this.stopped) return;
    this.ready = false;
    const child = spawn(this.options.executable || 'ssh', tunnelArguments(this.config), {
      env: tunnelEnvironment(), stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child = child;
    this.closed = new Promise(resolve => {
      let bound = false;
      const lines = createInterface({ input: child.stderr! });
      lines.on('line', line => {
        if (line.startsWith(`debug1: Local forwarding listening on 127.0.0.1 port ${this.config.localPort}.`)) bound = true;
        if (bound && line.startsWith('debug1: Entering interactive session.')) {
          this.ready = true; this.attempts = 0; this.problem = 'SSH connection closed.';
          this.options.report(`SSH tunnel ready on 127.0.0.1:${this.config.localPort}.`);
        }
        if (/Permission denied|Too many authentication failures/i.test(line)) this.problem = 'SSH authentication failed. Configure a key or ssh-agent for unattended login.';
        else if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(line)) this.problem = 'SSH host key verification failed. Verify the server key and connect manually on the host first.';
        else if (/Address already in use|cannot listen to port/i.test(line)) this.problem = 'The local SSH tunnel port is already in use. Stop the manually started tunnel or choose a different SYNAPSE_ADMIN_URL port.';
        else if (/Could not resolve hostname/i.test(line)) this.problem = 'SSH server hostname could not be resolved. Check SYNAPSE_SSH_TARGET and DNS.';
        else if (/Connection refused/i.test(line)) this.problem = 'SSH connection was refused. Check the server address and SYNAPSE_SSH_PORT.';
        else if (/Connection timed out|Operation timed out|No route to host|Network is unreachable/i.test(line)) this.problem = 'SSH server is unreachable or timed out. Check the network and server availability.';
      });
      child.once('error', error => { this.problem = errorMessage(error, 'Could not launch OpenSSH. Install ssh and ensure it is on the connector PATH.'); });
      child.once('close', (code, signal) => {
        lines.close(); this.child = undefined; this.ready = false;
        if (!this.stopped) {
          if (this.problem === 'SSH connection is starting.') this.problem = 'SSH connection closed.';
          const retryMs = this.options.retryMs ?? Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5));
          this.options.report(`${this.problem} ${safeErrorSummary({ code, signal })}. Reconnecting in ${retryMs / 1000}s.`);
          this.retry = setTimeout(() => this.launch(), retryMs);
        }
        resolve();
      });
    });
  }

  async waitUntilReady(signal?: AbortSignal, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.ready && !this.stopped && Date.now() < deadline) {
      signal?.throwIfAborted();
      await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
    signal?.throwIfAborted();
    if (!this.ready || this.stopped) throw new PublicError(`Automatic SSH tunnel is not ready. ${this.problem} It will reconnect automatically while the connector is running; retry bot creation shortly.`);
  }

  async stop(): Promise<void> {
    this.stopped = true; this.ready = false;
    clearTimeout(this.retry);
    process.removeListener('exit', this.onExit);
    const child = this.child;
    if (!child) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), this.options.killMs ?? 2000);
    try { await this.closed; } finally { clearTimeout(timer); }
  }
}
