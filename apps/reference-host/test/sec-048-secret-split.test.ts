/**
 * SEC-048 criterion 2 (owner decision 107): on the demo stack each long-running part holds only
 * the generated secrets it needs.
 *
 * - The files: `ensureSecrets` writes the operator's complete record and one file per role; the
 *   service's file holds its signing key, view key and cursor secret, the host's file the API key
 *   and the host's signing key, and neither holds a value of the other.
 * - The environment: `roleEnv`, given only a role's file, builds the environment of that part, and
 *   no part's environment holds a generated secret of another part. The export worker has none.
 * - The mounts: compose.json gives only `setup` the operator volume and every role volume; each
 *   other part mounts its own role volume read-only, or none.
 * - The containers (needs Podman and an image of Alpine already on the machine; skips otherwise):
 *   the volumes of compose.json are filled as `setup` fills them, and each part's mounts and
 *   environment are started as a container without privileges (uid 1000, no capabilities, no
 *   network, no new privileges) that lists its environment and every file under `/secrets`.
 *   The image is Alpine, not the demo image: the demo image's base is pinned by digest and is not
 *   on this machine, so what is run is the mount layout and the files, not the services.
 */
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  ensureSecrets,
  readRoleSecrets,
  roleEnv,
  roleSecretsFile,
  stackSettings,
  type Secrets,
} from '../scripts/lib/stack.ts';

const dir = mkdtempSync(join(tmpdir(), 'sec048-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface ComposeService {
  environment?: Record<string, string>;
  volumes?: string[];
  'x-docedit-process'?: boolean;
}
const compose = JSON.parse(readFileSync(new URL('../compose.json', import.meta.url), 'utf8')) as {
  services: Record<string, ComposeService>;
  volumes: Record<string, unknown>;
};

const secrets = await ensureSecrets('tenant-sec048', dir, dir);
const serviceValues = [
  secrets.serviceSigning['d'] as string,
  secrets.viewKey,
  secrets.cursorSecret,
];
const hostValues = [
  secrets.hostSigning['d'] as string,
  secrets.apiKey.secret,
  secrets.apiKey.credential,
];

describe('SEC-048 criterion 2: the secret files of the demo stack', () => {
  it('has a complete record for the operator and one file per role', async () => {
    const all = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')) as Secrets;
    expect(all.apiKey.secret).toBe(secrets.apiKey.secret);
    expect(Object.keys(await readRoleSecrets('service', dir)).sort()).toEqual(
      ['cursorSecret', 'serviceSigning', 'viewKey', 'x-note'].sort(),
    );
    expect(Object.keys(await readRoleSecrets('host', dir)).sort()).toEqual(
      ['apiKey', 'hostSigning', 'x-note'].sort(),
    );
  });

  it("keeps no value of another role in a role's file", () => {
    const service = readFileSync(roleSecretsFile('service', dir), 'utf8');
    const host = readFileSync(roleSecretsFile('host', dir), 'utf8');
    for (const v of serviceValues) {
      expect(service).toContain(v);
      expect(host).not.toContain(v);
    }
    for (const v of hostValues) {
      expect(host).toContain(v);
      expect(service).not.toContain(v);
    }
  });

  it('keeps the role files when the record already exists (an older stack gains them)', async () => {
    rmSync(roleSecretsFile('host', dir));
    const again = await ensureSecrets('tenant-sec048', dir, dir);
    expect(again.apiKey.secret).toBe(secrets.apiKey.secret);
    expect((await readRoleSecrets('host', dir)).apiKey.secret).toBe(secrets.apiKey.secret);
  });
});

describe('SEC-048 criterion 2: the environment of each part', () => {
  const s = stackSettings();
  it('is built from the role file alone, and holds no secret of another part', async () => {
    const service = roleEnv('service', s, await readRoleSecrets('service', dir), dir);
    const host = roleEnv('host', s, await readRoleSecrets('host', dir), dir);
    const worker = roleEnv('worker', s, {}, dir);
    const text = (e: Record<string, string>): string => JSON.stringify(e);
    for (const v of serviceValues) {
      expect(text(service)).toContain(v);
      expect(text(host)).not.toContain(v);
      expect(text(worker)).not.toContain(v);
    }
    for (const v of hostValues) {
      expect(text(host)).toContain(v);
      expect(text(service)).not.toContain(v);
      expect(text(worker)).not.toContain(v);
    }
  });

  it('refuses a part that is given the wrong role file', async () => {
    expect(() => roleEnv('service', s, { viewKey: 'x' }, dir)).toThrow(/serviceSigning/);
    expect(() => roleEnv('host', s, {}, dir)).toThrow(/apiKey/);
  });
});

/** The named volumes a service of compose.json mounts, as `{ name, path, readOnly }`. */
function mounts(name: string): Array<{ name: string; path: string; readOnly: boolean }> {
  return (compose.services[name]?.volumes ?? [])
    .map((v) => v.split(':'))
    .filter(([n]) => n !== undefined && n in compose.volumes)
    .map(([n, path, mode]) => ({
      name: n as string,
      path: path as string,
      readOnly: mode === 'ro',
    }));
}
const secretVolumes = (name: string): string[] =>
  mounts(name)
    .filter((m) => m.name.startsWith('secrets-'))
    .map((m) => m.name);

describe('SEC-048 criterion 2: the mounts of compose.json', () => {
  it('gives only setup the operator volume and every role volume', () => {
    expect(secretVolumes('setup').sort()).toEqual(
      ['secrets-host', 'secrets-operator', 'secrets-service'].sort(),
    );
    for (const name of Object.keys(compose.services))
      if (name !== 'setup') expect(secretVolumes(name)).not.toContain('secrets-operator');
  });

  it("gives each part its own role's volume, read-only, and the worker none", () => {
    expect(secretVolumes('document-service')).toEqual(['secrets-service']);
    expect(secretVolumes('reference-host')).toEqual(['secrets-host']);
    expect(secretVolumes('seed')).toEqual(['secrets-host']);
    expect(secretVolumes('export-worker')).toEqual([]);
    for (const name of ['document-service', 'reference-host', 'seed'])
      for (const m of mounts(name).filter((m) => m.name.startsWith('secrets-')))
        expect(m.readOnly).toBe(true);
  });

  it('keeps the secrets out of the volume the parts share', () => {
    // `stack-data` is mounted by every part; the operator's record must not be written into it.
    expect(compose.services['setup']?.environment?.['DOCEDIT_DEMO_SECRETS']).toBe('/secrets');
    expect(mounts('setup').find((m) => m.name === 'secrets-operator')?.path).toBe('/secrets');
  });
});

const CLI = process.env['DOCEDIT_CONTAINER_CLI'] || 'podman';
const IMAGE = 'docker.io/library/alpine:3';
const cgroups =
  process.env['DOCEDIT_CONTAINER_CGROUPS'] === 'disabled' ? ['--cgroups=disabled'] : [];
const exec = promisify(execFile);
const run = (args: string[]) => exec(CLI, args, { encoding: 'utf8', timeout: 600_000 });
const podmanReady = spawnSync(CLI, ['image', 'exists', IMAGE], { timeout: 120_000 }).status === 0;
const PREFIX = 'docedit-sec048-w8-';
const vol = (name: string): string => `${PREFIX}${name}`;
const volumeNames = (): string[] => Object.keys(compose.volumes).map(vol);

// A busy Podman machine takes tens of seconds for one command.
vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

describe.skipIf(!podmanReady)('SEC-048 criterion 2: containers without privileges (Podman)', () => {
  afterAll(async () => {
    await run(['volume', 'rm', '-f', ...volumeNames()]).catch(() => undefined);
  });

  /** One container of a part of compose.json, with its mounts and environment, on Alpine. */
  async function container(
    name: string,
    user: string,
    script: string,
    extraEnv: Record<string, string> = {},
  ): Promise<string> {
    const args = ['run', '--rm', ...cgroups, '--pull=never', '--network=none'];
    if (user !== 'root')
      args.push('--user', user, '--cap-drop=all', '--security-opt=no-new-privileges');
    for (const m of mounts(name))
      args.push('-v', `${vol(m.name)}:${m.path}${m.readOnly ? ':ro' : ''}`);
    const env = { ...compose.services[name]?.environment, ...extraEnv };
    for (const [k, v] of Object.entries(env)) if (!v.includes('${')) args.push('-e', `${k}=${v}`);
    args.push(IMAGE, 'sh', '-c', script);
    return (await run(args)).stdout;
  }

  it('fills the volumes as setup does, then each part sees only its own role', async () => {
    await run(['volume', 'rm', '-f', ...volumeNames()]);
    const b64 = (path: string): string => readFileSync(path).toString('base64');
    // Setup's mounts: the operator volume at /secrets and each role volume below it.
    await container(
      'setup',
      'root',
      [
        'mkdir -p /secrets/role-service /secrets/role-host',
        'echo "$OPERATOR" | base64 -d > /secrets/secrets.json',
        'echo "$SERVICE" | base64 -d > /secrets/role-service/secrets.json',
        'echo "$HOST" | base64 -d > /secrets/role-host/secrets.json',
        'chmod 600 /secrets/secrets.json /secrets/role-service/secrets.json /secrets/role-host/secrets.json',
        'chown -R 1000:1000 /secrets /stack',
      ].join(' && '),
      {
        OPERATOR: b64(join(dir, 'secrets.json')),
        SERVICE: b64(roleSecretsFile('service', dir)),
        HOST: b64(roleSecretsFile('host', dir)),
      },
    );

    const probe = [
      'echo "ENV"; env',
      'echo "FILES"; find /secrets /stack -type f 2>/dev/null',
      'echo "CONTENT"; for f in $(find /secrets -type f 2>/dev/null); do cat "$f"; done',
      'echo "WRITE"; (echo x > /secrets/role-service/x 2>/dev/null && echo wrote) || echo refused',
      'echo "UID"; id -u',
    ].join('; ');
    const names = ['document-service', 'reference-host', 'seed', 'export-worker'];
    const outputs = await Promise.all(names.map((n) => container(n, '1000:1000', probe)));
    const seen: Record<
      string,
      { env: string; files: string[]; content: string; uid: string; write: string }
    > = {};
    names.forEach((name, i) => {
      const out = outputs[i] ?? '';
      const section = (from: string, to: string | null): string => {
        const a = out.indexOf(`${from}\n`) + from.length + 1;
        const b = to === null ? out.length : out.indexOf(`\n${to}\n`);
        return out.slice(a, b);
      };
      seen[name] = {
        env: section('ENV', 'FILES'),
        files: section('FILES', 'CONTENT').split('\n').filter(Boolean),
        content: section('CONTENT', 'WRITE'),
        write: section('WRITE', 'UID').trim(),
        uid: section('UID', null).trim(),
      };
    });
    for (const part of Object.values(seen)) expect(part.uid).toBe('1000');
    const secretFiles = (name: string): string[] =>
      seen[name]!.files.filter((f) => f.startsWith('/secrets'));
    expect(secretFiles('document-service')).toEqual(['/secrets/role-service/secrets.json']);
    expect(secretFiles('reference-host')).toEqual(['/secrets/role-host/secrets.json']);
    expect(secretFiles('seed')).toEqual(['/secrets/role-host/secrets.json']);
    expect(secretFiles('export-worker')).toEqual([]);

    const everything = (name: string): string => seen[name]!.env + seen[name]!.content;
    for (const v of serviceValues) {
      expect(everything('document-service')).toContain(v);
      for (const name of ['reference-host', 'seed', 'export-worker'])
        expect(everything(name)).not.toContain(v);
    }
    for (const v of hostValues) {
      for (const name of ['reference-host', 'seed']) expect(everything(name)).toContain(v);
      for (const name of ['document-service', 'export-worker'])
        expect(everything(name)).not.toContain(v);
    }
    // A part cannot write where it only reads.
    expect(seen['document-service']!.write).toBe('refused');
  });
});
