/**
 * The container command line. The worker calls Podman, never Docker; DOCEDIT_CONTAINER_CLI
 * overrides the binary (default `podman`). The same approach as the export worker's sandbox
 * (services/export-worker/src/container.ts), kept separate because the two workers are separate
 * deployables.
 *
 * DOCEDIT_PODMAN_MACHINE: on a Windows or macOS host, the name of a Podman machine to run
 * `podman --cgroup-manager=cgroupfs ...` inside, through `podman machine ssh`. A development route
 * only: on a WSL machine whose systemd cgroup manager delegates no controllers, `--memory`,
 * `--cpus` and `--pids-limit` fail through the remote client, which cannot pass
 * `--cgroup-manager`. Because ssh joins the arguments into one shell command line, every argument
 * is checked against a strict pattern and the call is refused otherwise.
 */
import { spawn, spawnSync } from 'node:child_process';

export function containerCli(): string {
  return process.env['DOCEDIT_CONTAINER_CLI'] || 'podman';
}

export function podmanMachine(): string | null {
  const m = process.env['DOCEDIT_PODMAN_MACHINE'];
  return m && /^[A-Za-z0-9_.-]+$/.test(m) ? m : null;
}

const SSH_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** The program and arguments that run `podman <args>` the configured way. */
export function podmanCommand(args: readonly string[]): { file: string; args: string[] } {
  const machine = podmanMachine();
  if (!machine) return { file: containerCli(), args: [...args] };
  for (const a of args)
    if (!SSH_SAFE.test(a)) throw new Error(`refusing to pass an argument through ssh: ${a}`);
  return {
    file: containerCli(),
    args: ['machine', 'ssh', machine, 'podman', '--cgroup-manager=cgroupfs', ...args],
  };
}

export interface RunResult {
  code: number | null;
  signal: string | null;
  stdout: Uint8Array;
  stderr: string;
  /** Standard output went past its limit and the process was killed. */
  stdoutOverflow: boolean;
  /** The wall-clock limit was reached and the process was killed. */
  timedOut: boolean;
  /** The caller aborted the run. */
  aborted: boolean;
  /** The program could not be started at all. */
  spawnError: string | null;
  wallMs: number;
}

export interface RunOptions {
  stdin?: Uint8Array;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
  /** Called after a timeout, an overflow or an abort, to stop the container itself. */
  onKill?: () => void;
}

/** Runs a program with bounded output and a wall-clock limit. Its output is treated as hostile. */
export function run(file: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let err = '';
    const maxErr = opts.maxStderrBytes ?? 16 * 1024;
    let stdoutOverflow = false;
    let timedOut = false;
    let aborted = false;
    let spawnError: string | null = null;
    let killed = false;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      opts.onKill?.();
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c: Buffer) => {
      if (stdoutOverflow) return;
      size += c.length;
      if (size > opts.maxStdoutBytes) {
        stdoutOverflow = true;
        chunks.length = 0;
        kill();
        return;
      }
      chunks.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < maxErr) err += c.toString('utf8').slice(0, maxErr - err.length);
    });
    child.on('error', (e) => {
      spawnError = e.message;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        signal,
        stdout: new Uint8Array(Buffer.concat(chunks)),
        stderr: err,
        stdoutOverflow,
        timedOut,
        aborted,
        spawnError,
        wallMs: performance.now() - started,
      });
    });
    child.stdin.on('error', () => {});
    if (opts.signal?.aborted) onAbort();
    if (opts.stdin)
      child.stdin.end(Buffer.from(opts.stdin.buffer, opts.stdin.byteOffset, opts.stdin.byteLength));
    else child.stdin.end();
  });
}

/** Runs `podman <args>` the configured way. */
export function podman(args: readonly string[], opts: RunOptions): Promise<RunResult> {
  const cmd = podmanCommand(args);
  return run(cmd.file, cmd.args, opts);
}

/** The name of a running Podman machine, or null. */
export function runningMachine(): string | null {
  const r = spawnSync(containerCli(), ['machine', 'list', '--format', 'json'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (r.status !== 0) return null;
  try {
    const list = JSON.parse(r.stdout) as Array<{ Name?: string; Running?: boolean }>;
    return list.find((m) => m.Running)?.Name?.replace(/\*$/, '') ?? null;
  } catch {
    return null;
  }
}
