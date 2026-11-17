/**
 * FND-010 criterion 2: the integration-test environment and the reference host's demo stack share
 * their container definitions instead of each writing them out. PostgreSQL, the S3-compatible
 * store and the sandbox settings are defined once, in infra/containers/compose.base.json, and both
 * compose files take them with `extends`. The two scripts that start the files with `podman run`
 * resolve `extends` with infra/containers/compose-extends.ps1, which is run here with pwsh.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkCompose } from './supply-chain/pin-check.ts';

const REPO = resolve(import.meta.dirname, '..');
const BASE = 'infra/containers/compose.base.json';
const TEST_ENV = 'infra/containers/compose.json';
const DEMO = 'apps/reference-host/compose.json';

type Service = Record<string, unknown> & {
  extends?: { file: string; service: string };
  image?: string;
  environment?: Record<string, string>;
  healthcheck?: Record<string, unknown>;
};
interface Compose {
  services: Record<string, Service>;
}

const read = (file: string): Compose =>
  JSON.parse(readFileSync(join(REPO, file), 'utf8')) as Compose;

/** The definition as the scripts see it: `extends` resolved by compose-extends.ps1. */
function resolved(file: string): Compose {
  const script = join(REPO, 'infra/containers/compose-extends.ps1');
  const out = execFileSync(
    'pwsh',
    [
      '-NoProfile',
      '-Command',
      `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); . '${script}'; Read-ComposeDefinition '${file}' | ConvertTo-Json -Depth 20 -Compress`,
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(out) as Compose;
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('the container definitions are shared, not duplicated (FND-010 criterion 2)', () => {
  const base = read(BASE);
  const shared: Array<[file: string, service: string, from: string]> = [
    [TEST_ENV, 'postgres', 'postgres'],
    [TEST_ENV, 's3', 's3'],
    [TEST_ENV, 'export-worker', 'export-sandbox'],
    [DEMO, 'postgres', 'postgres'],
    [DEMO, 's3', 's3'],
    [DEMO, 'export-sandbox', 'export-sandbox'],
  ];

  it.each(shared)('%s: %s extends %s of the shared file', (file, service, from) => {
    const svc = read(file).services[service]!;
    expect(svc.extends?.service).toBe(from);
    expect(resolve(REPO, file, '..', svc.extends!.file)).toBe(resolve(REPO, BASE));
    // Nothing the shared service says is said again: no member of it, and no key of a mapping.
    const baseSvc = base.services[from]!;
    for (const [key, value] of Object.entries(baseSvc)) {
      if (key === 'x-note') continue;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const own = (svc[key] ?? {}) as Record<string, unknown>;
        for (const inner of Object.keys(value)) expect(own, `${key}.${inner}`).not.toHaveProperty(inner);
      } else {
        expect(svc, key).not.toHaveProperty(key);
      }
    }
  });

  it('only the shared file names the images of PostgreSQL and of the store, pinned by digest', () => {
    for (const file of [TEST_ENV, DEMO]) {
      const text = readFileSync(join(REPO, file), 'utf8');
      expect(text).not.toMatch(/docker\.io\/|@sha256:/);
    }
    expect(base.services['postgres']!.image).toMatch(/^docker\.io\/library\/postgres:.+@sha256:/);
    expect(base.services['s3']!.image).toMatch(/^docker\.io\/versity\/versitygw:.+@sha256:/);
    for (const file of [BASE, TEST_ENV, DEMO])
      expect(checkCompose(readFileSync(join(REPO, file), 'utf8'), file)).toEqual([]);
  });

  it('both environments resolve to the same images and fixed settings', () => {
    const test = resolved(join(REPO, TEST_ENV)).services;
    const demo = resolved(join(REPO, DEMO)).services;
    for (const name of ['postgres', 's3']) {
      const b = base.services[name]!;
      for (const svc of [test[name]!, demo[name]!]) {
        expect(svc).not.toHaveProperty('extends');
        expect(svc.image).toBe(b.image);
        expect(svc['network_mode']).toBe('host');
        expect(svc.environment).toMatchObject(b.environment!);
        expect(svc.healthcheck).toMatchObject(b.healthcheck!);
        // What differs stays with each file: the port in the health check, the credentials.
        expect(Array.isArray(svc.healthcheck!['test'])).toBe(true);
      }
    }
    expect(test['postgres']!.environment).toHaveProperty('POSTGRES_USER', '${DOCEDIT_PG_ADMIN_USER}');
    expect(demo['postgres']!.environment).toHaveProperty(
      'POSTGRES_USER',
      '${DOCEDIT_DEMO_PG_ADMIN_USER}',
    );
    expect(test['postgres']).toHaveProperty('tmpfs');
    expect(demo['postgres']).toHaveProperty('volumes');
    const sandbox = base.services['export-sandbox']!;
    const { 'x-note': _note, ...settings } = sandbox;
    expect(test['export-worker']).toMatchObject(settings);
    expect(demo['export-sandbox']).toMatchObject(settings);
    expect(settings).toMatchObject({ network_mode: 'none', read_only: true, cap_drop: ['ALL'] });
  });

  it('resolves extends by Compose’s merge rules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fnd-010-w5-'));
    dirs.push(dir);
    writeFileSync(
      join(dir, 'base.json'),
      JSON.stringify({
        services: {
          a: {
            image: 'example.test/a@sha256:0',
            environment: { KEPT: '1', REPLACED: 'base' },
            command: ['base', 'command'],
            tmpfs: ['/base'],
            healthcheck: { test: ['CMD', 'base'], interval: '1s' },
            user: '1:1',
          },
        },
      }),
    );
    writeFileSync(
      join(dir, 'compose.json'),
      JSON.stringify({
        services: {
          a: {
            extends: { file: './base.json', service: 'a' },
            environment: { REPLACED: 'local', ADDED: '2' },
            command: ['local'],
            tmpfs: ['/local'],
            healthcheck: { test: ['CMD', 'local'] },
            user: '2:2',
          },
          plain: { image: 'example.test/b@sha256:0' },
        },
      }),
    );
    const { a, plain } = resolved(join(dir, 'compose.json')).services;
    expect(a).toEqual({
      image: 'example.test/a@sha256:0',
      environment: { KEPT: '1', REPLACED: 'local', ADDED: '2' },
      command: ['local'],
      tmpfs: ['/base', '/local'],
      healthcheck: { test: ['CMD', 'local'], interval: '1s' },
      user: '2:2',
    });
    expect(plain).toEqual({ image: 'example.test/b@sha256:0' });

    writeFileSync(
      join(dir, 'missing.json'),
      JSON.stringify({ services: { a: { extends: { file: './base.json', service: 'nope' } } } }),
    );
    expect(() => resolved(join(dir, 'missing.json'))).toThrow(/does not define/);
  });
});
