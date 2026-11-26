/**
 * Starts the reference service (`services/document-service`) as a separate process, the way an
 * operator runs it, and hands the kit only what 05 §11 allows: the discovery URL and a service
 * credential (plus an origin registered for the kit's tenant). Nothing of the service is imported:
 * the tenant is registered through its documented seed file (BE-012), on in-memory storage unless
 * DOCEDIT_TCK_DATABASE_URL names a database.
 *
 * The API-key format (`dsk_<tenant>_<key id>_<secret>`) is the reference service's own, not part of
 * DEP; it is written here because the seed file stores only the secret's SHA-256.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StartedTarget {
  readonly name: string;
  readonly discovery: string;
  readonly credential: string;
  /** A service credential of a second tenant, for the cross-tenant scenarios (UX-076). */
  readonly otherCredential?: string;
  readonly origin: string;
  readonly testMode: boolean;
  /** Recent output of the process, for failure reports. */
  logs(): string;
  stop(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../../../..');
export const KIT_ORIGIN = 'https://kit.tck.example';

export interface ReferenceOptions {
  /** Extra environment for the service (for example DOCEDIT_FEATURES). */
  env?: Record<string, string>;
  /** How long to wait for the process to listen (default 30 s). */
  startTimeoutMs?: number;
}

export async function startReference(opts: ReferenceOptions = {}): Promise<StartedTarget> {
  const tenant = randomUUID();
  const keyId = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const otherTenant = randomUUID();
  const otherKeyId = randomUUID();
  const otherSecret = randomBytes(32).toString('base64url');
  const dir = mkdtempSync(join(tmpdir(), 'docedit-tck-'));
  const seedFile = join(dir, 'tenants.json');
  writeFileSync(
    seedFile,
    JSON.stringify({
      tenants: [
        {
          id: tenant,
          name: 'conformance kit',
          apiKeys: [
            {
              id: keyId,
              secretSha256: createHash('sha256').update(secret, 'utf8').digest('hex'),
              label: 'tck',
            },
          ],
          origins: [KIT_ORIGIN],
        },
        {
          id: otherTenant,
          name: 'second tenant of the kit',
          apiKeys: [
            {
              id: otherKeyId,
              secretSha256: createHash('sha256').update(otherSecret, 'utf8').digest('hex'),
              label: 'tck-other',
            },
          ],
          origins: ['https://other.tck.example'],
        },
      ],
    }),
  );
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DOCEDIT_LISTEN_HOST: '127.0.0.1',
    DOCEDIT_LISTEN_PORT: '0',
    DOCEDIT_TENANTS_FILE: seedFile,
    DOCEDIT_WORKERS: '1',
    DOCEDIT_NODE_ID: `tck-${process.pid}`,
    ...opts.env,
  };
  if (process.env['DOCEDIT_TCK_DATABASE_URL'])
    env['DOCEDIT_DATABASE_URL'] = process.env['DOCEDIT_TCK_DATABASE_URL'];
  else delete env['DOCEDIT_DATABASE_URL'];
  const child: ChildProcess = spawn(
    process.execPath,
    [join(ROOT, 'services/document-service/src/main.ts')],
    {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const lines: string[] = [];
  const keep = (chunk: Buffer) => {
    for (const l of chunk.toString('utf8').split(/\r?\n/)) if (l) lines.push(l);
    if (lines.length > 400) lines.splice(0, lines.length - 400);
  };
  const url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`the reference service did not start:\n${lines.slice(-20).join('\n')}`)),
      opts.startTimeoutMs ?? 30_000,
    );
    child.stdout!.on('data', (chunk: Buffer) => {
      keep(chunk);
      const m = /listening on (http:\/\/[^\s"]+)/.exec(chunk.toString('utf8'));
      if (m) {
        clearTimeout(timer);
        resolveUrl(m[1]!);
      }
    });
    child.stderr!.on('data', keep);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(`the reference service exited with ${code}:\n${lines.slice(-20).join('\n')}`),
      );
    });
  });
  return {
    name: 'reference service',
    discovery: `${url}/.well-known/dep`,
    credential: `dsk_${tenant}_${keyId}_${secret}`,
    otherCredential: `dsk_${otherTenant}_${otherKeyId}_${otherSecret}`,
    origin: KIT_ORIGIN,
    testMode: false,
    logs: () => lines.join('\n'),
    stop: () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null) return done();
        child.once('exit', () => done());
        child.kill();
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 5000);
      }),
  };
}
