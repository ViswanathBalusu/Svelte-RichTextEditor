// The demo stack's configuration (UX-091 criteria 3 and 4; BE-005 criteria 2 and 4): the secrets are
// generated once per volume and marked demo-only, the allowed origins come from the stack's
// settings, the README says it is not a production deployment, and the compose definition gives the
// sandbox no network. Containers are not run here: the checks that need Podman stay unticked.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allowedOrigins,
  ensureSecrets,
  roleEnv,
  SECRETS_FILE,
  stackSettings,
  type Secrets,
  type Settings,
} from '../scripts/lib/stack.ts';

const APP_DIR = join(import.meta.dirname, '..');
const SETTINGS: Settings = { DOCEDIT_DEMO_HOST_PORT: '56490' };

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function freshDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'docedit-stack-test-'));
  dirs.push(d);
  return d;
}

describe('the demo secrets (UX-091 criterion 4)', () => {
  it('are generated once into the data directory and marked demo-only', async () => {
    const dir = await freshDir();
    const first = await ensureSecrets('7d6c3a90-5b1e-4f2a-9c84-0e1f2a3b4c5d', dir);
    expect(first['x-note']).toMatch(/Demo only/);
    expect(first.apiKey.credential).toMatch(/^dsk_7d6c3a90-5b1e-4f2a-9c84-0e1f2a3b4c5d_/);
    // The host's private key stays in the data directory: the public half is all the service gets.
    expect(first.hostSigning).toHaveProperty('d');
    expect(first.hostPublic).not.toHaveProperty('d');
    // Reading the file again gives the same secrets: a restart keeps them.
    const again = await ensureSecrets('7d6c3a90-5b1e-4f2a-9c84-0e1f2a3b4c5d', dir);
    expect(again).toEqual(first);
    const onDisk = JSON.parse(await readFile(join(dir, SECRETS_FILE), 'utf8')) as {
      'x-note': string;
    };
    expect(onDisk['x-note']).toBe(first['x-note']);
  });

  it('are different for a new volume, so no value is shared between stacks', async () => {
    const a = await ensureSecrets('t', await freshDir());
    const b = await ensureSecrets('t', await freshDir());
    expect(a.apiKey.secret).not.toBe(b.apiKey.secret);
    expect(a.viewKey).not.toBe(b.viewKey);
    expect(a.hostSigning).not.toEqual(b.hostSigning);
  });
});

describe('the seeded allowed origins (UX-091 criterion 3; BE-005 criterion 2)', () => {
  it('come from the stack settings: the host port on 127.0.0.1 and localhost only', () => {
    expect(allowedOrigins(SETTINGS)).toEqual(['http://127.0.0.1:56490', 'http://localhost:56490']);
  });
});

describe('the demo is marked as not production (UX-091 criterion 4)', () => {
  it('the README says so, and the compose definition says so', async () => {
    const readme = await readFile(join(APP_DIR, 'README.md'), 'utf8');
    expect(readme).toContain('**Demo only. This is not a production deployment.**');
    const compose = JSON.parse(await readFile(join(APP_DIR, 'compose.json'), 'utf8')) as {
      'x-note': string;
    };
    expect(compose['x-note']).toMatch(/Demo only: not a production deployment/);
  });
});

describe('the compose definition (UX-091 criterion 1 in part; BE-005 criterion 4 in part)', () => {
  it('names every part of the demo stack', async () => {
    const compose = JSON.parse(await readFile(join(APP_DIR, 'compose.json'), 'utf8')) as {
      services: Record<string, { network_mode?: string }>;
    };
    expect(Object.keys(compose.services).sort()).toEqual(
      [
        'document-service',
        'export-sandbox',
        'export-worker',
        'mail',
        'postgres',
        'reference-host',
        's3',
        'seed',
        'setup',
      ].sort(),
    );
  });

  it('has a development mail sink, pinned by digest, and the host sends to it (UX-098 criterion 5)', async () => {
    const compose = JSON.parse(await readFile(join(APP_DIR, 'compose.json'), 'utf8')) as {
      services: Record<string, { image?: string }>;
    };
    expect(compose.services['mail']?.image).toMatch(
      /^docker\.io\/axllent\/mailpit:v[\d.]+@sha256:[0-9a-f]{64}$/,
    );
    const s = stackSettings({});
    const secrets: Secrets = await ensureSecrets('t-demo', await freshDir());
    const env = roleEnv('host', s, secrets, '/stack');
    expect(env['DOCEDIT_HOST_SMTP']).toBe(`127.0.0.1:${s['DOCEDIT_DEMO_MAIL_SMTP_PORT']}`);
    expect(env['DOCEDIT_HOST_PUBLIC_URL']).toBe(`http://127.0.0.1:${s['DOCEDIT_DEMO_HOST_PORT']}`);
  });

  it('gives the export sandbox no network (the worker runs its jobs there, 09 §9.3)', async () => {
    type Services = Record<
      string,
      { network_mode?: string; read_only?: boolean; extends?: { file: string; service: string } }
    >;
    const compose = JSON.parse(await readFile(join(APP_DIR, 'compose.json'), 'utf8')) as {
      services: Services;
    };
    // The sandbox settings are those of the integration-test environment, taken with `extends`
    // (FND-010 criterion 2), and the demo's file does not set them again.
    const sandbox = compose.services['export-sandbox']!;
    expect(sandbox.extends?.service).toBe('export-sandbox');
    expect(sandbox).not.toHaveProperty('network_mode');
    const shared = JSON.parse(await readFile(join(APP_DIR, sandbox.extends!.file), 'utf8')) as {
      services: Services;
    };
    expect(shared.services['export-sandbox']).toMatchObject({
      network_mode: 'none',
      read_only: true,
    });
  });
});
