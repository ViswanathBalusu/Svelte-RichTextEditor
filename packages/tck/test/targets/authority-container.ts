/**
 * Starts the reference authority service as a container (BE-007): the image of
 * `services/authority-service/Containerfile`, run with the options of its compose entry
 * (`services/authority-service/compose.json`), and hands the kit only its address. Nothing of the
 * service is imported.
 *
 * `podman compose` needs a Compose provider. Where there is none the service of the compose file
 * is started with `podman run` and the same options, as `infra/test-env.ps1` does for the test
 * environment. The container binds loopback and a port the system chose (host networking; see the
 * note in compose.json). A restart kills the container with SIGKILL and starts it again: the
 * process in it is new and holds nothing of the one before.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from './reference.ts';

const run = promisify(execFile);

export interface AuthorityContainerOptions {
  /** The container's name. */
  name: string;
  /** The image tag to build and run. */
  image: string;
  /** Settings over the defaults of the compose file, for example `DOCEDIT_AUTHORITY_TOKEN`. */
  env?: Record<string, string>;
  /** The container command line; `DOCEDIT_CONTAINER_CLI`, then `podman`. */
  cli?: string;
  /** Build the image first. The layers are cached after the first build. */
  build?: boolean;
  startTimeoutMs?: number;
}

export interface ContainerFacts {
  image: string;
  readOnlyRoot: boolean;
  networkMode: string;
  user: string;
  capDrop: string[];
  status: string;
  startedAt: string;
}

export interface StartedAuthorityContainer {
  url: string;
  name: string;
  /** Kills the container and starts it again; returns its address, which stays the same. */
  restart(): Promise<string>;
  inspect(): Promise<ContainerFacts>;
  logs(): Promise<string>;
  /** Removes the container. */
  stop(): Promise<void>;
}

interface ComposeService {
  image: string;
  network_mode?: string;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  environment: Record<string, string>;
}

/** `${NAME:-default}` as Compose reads it, with the given settings over the defaults. */
function interpolate(text: string, env: Record<string, string>): string {
  return text.replace(
    /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g,
    (_m, name: string, fallback?: string) => env[name] ?? fallback ?? '',
  );
}

function freePort(): Promise<number> {
  return new Promise((ok, bad) => {
    const s = createServer();
    s.once('error', bad);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

async function ready(url: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(`${url}/v1/authority/ready`)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error(`the container was not ready within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

export async function startAuthorityContainer(
  opts: AuthorityContainerOptions,
): Promise<StartedAuthorityContainer> {
  const cli = opts.cli ?? process.env['DOCEDIT_CONTAINER_CLI'] ?? 'podman';
  const wait = opts.startTimeoutMs ?? 60_000;
  if (opts.build)
    await run(
      cli,
      [
        'build',
        '-f',
        'services/authority-service/Containerfile',
        '--ignorefile',
        'services/authority-service/Containerfile.dockerignore',
        '-t',
        opts.image,
        '.',
      ],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
    );

  const compose = JSON.parse(
    readFileSync(join(ROOT, 'services/authority-service/compose.json'), 'utf8'),
  ) as { services: Record<string, ComposeService> };
  const service = compose.services['authority-service'];
  if (!service) throw new Error('compose.json has no authority-service');
  const port = await freePort();
  const settings = {
    DOCEDIT_AUTHORITY_PORT: String(port),
    DOCEDIT_AUTHORITY_IMAGE: opts.image,
    ...opts.env,
  };
  // A remote Podman (a machine on Windows or macOS) cannot place the container in a cgroup.
  const remote =
    (await run(cli, ['info', '--format', '{{.Host.ServiceIsRemote}}'])).stdout.trim() === 'true';
  const args = ['run', '-d', '--name', opts.name, ...(remote ? ['--cgroups=disabled'] : [])];
  if (service.network_mode) args.push(`--network=${service.network_mode}`);
  if (service.read_only) args.push('--read-only');
  for (const c of service.cap_drop ?? []) args.push(`--cap-drop=${c}`);
  for (const o of service.security_opt ?? []) args.push('--security-opt', o);
  for (const [k, v] of Object.entries(service.environment)) {
    const value = interpolate(v, settings);
    if (value !== '') args.push('-e', `${k}=${value}`);
  }
  args.push(interpolate(service.image, settings));
  await run(cli, ['rm', '-f', '-t', '0', opts.name]).catch(() => undefined);
  await run(cli, args);
  const url = `http://127.0.0.1:${port}`;
  await ready(url, wait);

  return {
    url,
    name: opts.name,
    async restart() {
      await run(cli, ['kill', '--signal', 'KILL', opts.name]);
      await run(cli, ['wait', opts.name]);
      await run(cli, ['start', opts.name]);
      await ready(url, wait);
      return url;
    },
    async inspect() {
      const info = (
        JSON.parse((await run(cli, ['inspect', opts.name])).stdout) as Array<{
          ImageName: string;
          HostConfig: { ReadonlyRootfs: boolean; NetworkMode: string; CapDrop: string[] | null };
          Config: { User: string };
          State: { Status: string; StartedAt: string };
        }>
      )[0]!;
      return {
        image: info.ImageName,
        readOnlyRoot: info.HostConfig.ReadonlyRootfs,
        networkMode: info.HostConfig.NetworkMode,
        user: info.Config.User,
        capDrop: info.HostConfig.CapDrop ?? [],
        status: info.State.Status,
        startedAt: info.State.StartedAt,
      };
    },
    async logs() {
      const r = await run(cli, ['logs', '--tail', '200', opts.name]).catch(() => null);
      return r ? `${r.stdout}${r.stderr}` : '';
    },
    async stop() {
      await run(cli, ['rm', '-f', '-t', '0', opts.name]).catch(() => undefined);
    },
  };
}
