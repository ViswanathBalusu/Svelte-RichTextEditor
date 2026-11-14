/**
 * BE-005 criterion 4 (lane V-BE-001-014), partial: a check that the export-worker options of the
 * integration-test environment give a container with no network. It does not meet the criterion
 * (review round 3): infra/containers/compose.json is the test environment, not the stack that
 * starts the document service, and the stack's own worker (apps/reference-host/compose.json) has
 * network_mode host; only its compile sandbox has none. The worker's network is for the owner.
 *
 * This test reads
 * the export-worker service from it, creates a container from the same image with the same
 * options that infra/test-env.ps1 passes to `podman run` (network, read-only root, dropped
 * capabilities, no new privileges, user, tmpfs), then inspects the container with Podman and
 * removes it. The container is never started, so no job runs.
 *
 * Needs Podman and the export worker image named in infra/containers/.env.example
 * (localhost/docedit-export-worker:test), which infra/test-env.ps1 builds.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repoRoot = new URL('../../../../', import.meta.url);
const composePath = new URL('infra/containers/compose.json', repoRoot);
const envPath = new URL('infra/containers/.env.example', repoRoot);
const containerName = 'docedit-v-be-001-014-export-net';

type ComposeService = {
  image: string;
  network_mode?: string;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  user?: string;
  tmpfs?: string[];
};

function readEnv(path: URL): Record<string, string> {
  const map: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return map;
}

function expand(text: string, env: Record<string, string>): string {
  return text.replace(/\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}/g, (_m, key: string, dflt?: string) => {
    const v = env[key];
    return v !== undefined && v !== '' ? v : (dflt ?? '');
  });
}

const cli = readEnv(envPath)['DOCEDIT_CONTAINER_CLI'] ?? 'podman';
const env = readEnv(envPath);
const compose = JSON.parse(readFileSync(composePath, 'utf8')) as {
  services: Record<string, ComposeService>;
};
const service = compose.services['export-worker'];

function podman(args: string[]): string {
  return execFileSync(cli, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function removeIfPresent(): void {
  try {
    podman(['container', 'rm', '--force', containerName]);
  } catch {
    // Absent is the expected state.
  }
}

describe('BE-005 criterion 4: export worker has no network (compose definition)', () => {
  it('the compose definition of export-worker sets no network, read-only root and dropped capabilities', () => {
    expect(service).toBeDefined();
    expect(service?.network_mode).toBe('none');
    expect(service?.read_only).toBe(true);
    expect(service?.cap_drop).toEqual(['ALL']);
    expect(service?.security_opt).toContain('no-new-privileges');
    expect(service?.user).toBe('10001:10001');
  });

  it('a container made from the same options has NetworkMode none when inspected', () => {
    const image = expand(service!.image, env);
    expect(image).toBe('localhost/docedit-export-worker:test');

    // The image must exist locally; infra/test-env.ps1 builds it. A missing image fails here.
    podman(['image', 'exists', image]);

    removeIfPresent();
    try {
      const args = [
        'create',
        `--name=${containerName}`,
        `--label=org.docedit.project=docedit-v-be-001-014`,
        `--label=org.docedit.service=export-worker`,
        `--network=${service!.network_mode}`,
        '--read-only',
        ...service!.cap_drop!.map((c) => `--cap-drop=${c}`),
        ...service!.security_opt!.map((o) => `--security-opt=${o}`),
        `--user=${service!.user}`,
        ...service!.tmpfs!.map((t) => `--tmpfs=${expand(t, env)}`),
        image,
      ];
      podman(args);

      const inspected = podman([
        'container',
        'inspect',
        '--format',
        '{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{join .EffectiveCaps ","}}|{{join .BoundingCaps ","}}|{{.Config.User}}',
        containerName,
      ]);
      const [networkMode, readonlyRootfs, effectiveCaps, boundingCaps, user] = inspected.split('|');

      expect(networkMode).toBe('none');
      expect(readonlyRootfs).toBe('true');
      // --cap-drop=ALL leaves no effective or bounding capability.
      expect(effectiveCaps).toBe('');
      expect(boundingCaps).toBe('');
      expect(user).toBe('10001:10001');
    } finally {
      removeIfPresent();
    }
    // `podman create` on the WSL machine takes seconds; the default 5 s is too short.
  }, 120_000);
});
