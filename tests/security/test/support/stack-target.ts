/**
 * The compose stack of BE-005 as a target of the adversarial client (SEC-002 criterion 5): the
 * document service that `apps/reference-host/scripts/stack.ps1 up` started, on its own PostgreSQL
 * and S3-compatible store, reached over real HTTP and a real WebSocket. Nothing of the service is
 * in this process; the client attacks what is deployed.
 *
 * The stack is not started here. A suite asks for this target only when `DOCEDIT_DEMO_STACK=1`
 * (the switch services/document-service/test/stack/be-005-stack.test.ts uses), with the settings
 * the stack was started with in the environment (project name, ports, data directory). To start
 * the stack, run the suite and remove the stack in one go: tests/security/scripts/stack-suite.ps1.
 *
 * Settings come from `apps/reference-host/stack/.env.example`, then `stack/.env`, then the
 * environment, as for stack.ps1. What the stack registered is read from its data directory:
 * `tenants.json` (the registration the service applied at start: the tenant, the `kid` and issuer
 * of the host's key, the origins) and `secrets.json` (the host's API key and signing key). They
 * are demo-only values on 127.0.0.1, and none is printed. The files are read here and not through
 * the reference host's own module, so that this suite does not depend on the application's build.
 *
 * Tenants. `a` is the stack's own tenant, as its set-up registered it. It has no service-credential
 * key, so `serviceJwt(a)` signs with a key the stack does not know. `b` is a second tenant this
 * target registers through the service's own registry class over the stack's database, as an
 * operator would, because cross-tenant attacks need somewhere to go. On `close` the keys, the API
 * key and the origin of `b` are withdrawn and every document the target created is deleted.
 */
import { createPrivateKey, createPublicKey, type JsonWebKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, inTenant, PgTenantRegistry } from '@docedit/document-service';
import { clientFor, registerTenant, type Target, type TestTenant } from './harness.ts';
import { keyPair, type PublicJwk } from './jws.ts';

/** True when the suites are asked to run against the running stack. */
export const STACK_WANTED = process.env['DOCEDIT_DEMO_STACK'] === '1';

export interface StackTarget extends Target {
  /** The stack's project name: its containers are `<project>-postgres` and `<project>-s3`. */
  project: string;
  /** The features `GET /.well-known/dep` announced when the target was opened. */
  features: string[];
  /**
   * Whether the stack's own PostgreSQL holds a row for the document: a read of the `documents`
   * table over the stack's database port, not a question to the service.
   */
  documentStored(tenant: TestTenant, id: string): Promise<boolean>;
}

const APP = fileURLToPath(new URL('../../../../apps/reference-host/', import.meta.url));
const START =
  'start it with: pwsh -NoProfile -File apps/reference-host/scripts/stack.ps1 up -NoExport';

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

/** The stack's settings: the example file, the local file, then the environment. */
export function stackSettings(): Record<string, string> {
  const s = {
    ...readEnvFile(join(APP, 'stack', '.env.example')),
    ...readEnvFile(join(APP, 'stack', '.env')),
  };
  for (const k of Object.keys(s)) {
    const v = process.env[k];
    if (v) s[k] = v;
  }
  return s;
}

/** The stack's data directory: `DOCEDIT_DEMO_DATA`, or `.stack/` in the application. */
export function stackDataDir(): string {
  return resolve(process.env['DOCEDIT_DEMO_DATA'] || join(APP, '.stack'));
}

interface Registration {
  tenants: Array<{
    id: string;
    keys: Array<{ kid: string; use: string; alg: string; issuer?: string }>;
    origins: string[];
  }>;
}
interface Secrets {
  apiKey: { credential: string };
  hostSigning: JsonWebKey & { kid: string };
  hostPublic: JsonWebKey;
}

export async function openStackTarget(): Promise<StackTarget> {
  const s = stackSettings();
  const need = (name: string): string => {
    const v = s[name];
    if (!v) throw new Error(`${name} is not set (apps/reference-host/stack/.env.example)`);
    return v;
  };
  const base = `http://127.0.0.1:${need('DOCEDIT_DEMO_SERVICE_PORT')}`;
  const ready = await fetch(`${base}/readyz`).catch(() => null);
  if (!ready?.ok)
    throw new Error(`the stack's document service does not answer at ${base}/readyz; ${START}`);
  const discovery = (await (await fetch(`${base}/.well-known/dep`)).json()) as {
    features?: string[];
  };

  const dir = stackDataDir();
  const read = <T>(name: string): T => {
    const path = join(dir, name);
    if (!existsSync(path)) throw new Error(`${path} does not exist: is this the stack's data?`);
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  };
  const registered = read<Registration>('tenants.json').tenants[0];
  const secrets = read<Secrets>('secrets.json');
  const key = registered?.keys.find((k) => k.use === 'user' && k.kid === secrets.hostSigning.kid);
  if (!registered || !key || key.alg !== 'ES256' || !registered.origins[0])
    throw new Error(`${dir}/tenants.json does not register the host's key and an origin`);
  const hostPrivate = createPrivateKey({ key: secrets.hostSigning, format: 'jwk' });
  const a: TestTenant = {
    id: registered.id,
    apiKey: secrets.apiKey.credential,
    hostKey: {
      alg: 'ES256',
      privateKey: hostPrivate,
      publicKey: createPublicKey(hostPrivate),
      jwk: secrets.hostPublic as PublicJwk,
    },
    hostKid: key.kid,
    ...(key.issuer !== undefined ? { issuer: key.issuer } : {}),
    // Not registered with the stack: its tenant has an API key and no service-credential key.
    serviceKey: keyPair('ES256'),
    origin: registered.origins[0],
  };

  const enc = encodeURIComponent;
  const pool = createPool({
    connectionString: `postgres://${enc(need('DOCEDIT_DEMO_PG_SERVICE_USER'))}:${enc(
      need('DOCEDIT_DEMO_PG_SERVICE_PASSWORD'),
    )}@127.0.0.1:${need('DOCEDIT_DEMO_PG_PORT')}/${enc(need('DOCEDIT_DEMO_PG_DATABASE'))}`,
    max: 2,
  });
  pool.on('error', () => {});
  const registry = new PgTenantRegistry(pool);
  let b: Awaited<ReturnType<typeof registerTenant>>;
  try {
    b = await registerTenant(registry, 'https://app-b.example.test');
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }

  const now = (): number => Date.now();
  const serviceId = need('DOCEDIT_DEMO_SERVICE_ID');
  const client = clientFor(base, serviceId, now);
  const created: Array<{ tenant: TestTenant; id: string }> = [];
  return {
    project: need('DOCEDIT_DEMO_PROJECT'),
    features: discovery.features ?? [],
    base,
    wsUrl: `${base.replace(/^http/, 'ws')}/dep`,
    serviceId,
    a,
    b,
    now,
    ...client,
    async createDocument(tenant, content) {
      const id = await client.createDocument(tenant, content);
      created.push({ tenant, id });
      return id;
    },
    documentStored(tenant, id) {
      return inTenant(
        pool,
        tenant.id,
        async (c) => (await c.query('SELECT 1 FROM documents WHERE id = $1', [id])).rowCount === 1,
        { readOnly: true },
      );
    },
    async close() {
      try {
        // Leave the stack as it was found: no test document, and a second tenant nobody can use.
        // A delete is sent again once when the connection fails: after a pause the kept-alive
        // connection may have been closed by the service, and the delete is idempotent.
        for (const d of created) {
          const remove = () =>
            client.call('DELETE', `/v1/documents/${d.id}`, { token: d.tenant.apiKey });
          await remove().catch(remove);
        }
        await registry.removeApiKey(b.id, b.apiKeyId);
        await registry.removeKey(b.id, `host-${b.id}`);
        await registry.removeKey(b.id, `svc-${b.id}`);
        await registry.removeOrigin(b.id, b.origin);
      } finally {
        await pool.end().catch(() => {});
      }
    },
  };
}
