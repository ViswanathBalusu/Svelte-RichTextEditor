/**
 * Starts the reference authority service (`services/authority-service`) as a separate process, the
 * way an operator runs it (BE-007), and hands the kit only its address. Nothing of the service is
 * imported. The port is chosen by the system (`DOCEDIT_AUTHORITY_PORT=0`); the process announces its
 * address in its `service.started` log line.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './reference.ts';

export interface StartedAuthority {
  url: string;
  /** Stops the process and starts another one, which has no memory of the first. */
  restart(): Promise<string>;
  logs(): string;
  stop(): Promise<void>;
}

export interface AuthorityOptions {
  env?: Record<string, string>;
  startTimeoutMs?: number;
}

export async function startAuthority(opts: AuthorityOptions = {}): Promise<StartedAuthority> {
  const lines: string[] = [];
  let child: ChildProcess | undefined;

  const stopChild = (c: ChildProcess) =>
    new Promise<void>((done) => {
      if (c.exitCode !== null) return done();
      c.once('exit', () => done());
      c.kill();
      setTimeout(() => {
        if (c.exitCode === null) c.kill('SIGKILL');
      }, 5000);
    });

  const start = async (): Promise<string> => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      DOCEDIT_AUTHORITY_HOST: '127.0.0.1',
      DOCEDIT_AUTHORITY_PORT: '0',
      ...opts.env,
    };
    const c = spawn(process.execPath, [join(ROOT, 'services/authority-service/src/main.ts')], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = c;
    const keep = (chunk: Buffer) => {
      for (const l of chunk.toString('utf8').split(/\r?\n/)) if (l) lines.push(l);
      if (lines.length > 400) lines.splice(0, lines.length - 400);
    };
    return new Promise<string>((resolveUrl, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`the authority service did not start:\n${lines.slice(-20).join('\n')}`)),
        opts.startTimeoutMs ?? 30_000,
      );
      c.stdout!.on('data', (chunk: Buffer) => {
        keep(chunk);
        const m = /"event":"service\.started","url":"(http:\/\/[^"]+)"/.exec(
          chunk.toString('utf8'),
        );
        if (m) {
          clearTimeout(timer);
          resolveUrl(m[1]!);
        }
      });
      c.stderr!.on('data', keep);
      c.once('exit', (code) => {
        clearTimeout(timer);
        reject(
          new Error(`the authority service exited with ${code}:\n${lines.slice(-20).join('\n')}`),
        );
      });
    });
  };

  const url = await start();
  return {
    url,
    logs: () => lines.join('\n'),
    async restart() {
      if (child) {
        child.removeAllListeners('exit');
        await stopChild(child);
      }
      return start();
    },
    async stop() {
      if (child) await stopChild(child);
    },
  };
}
