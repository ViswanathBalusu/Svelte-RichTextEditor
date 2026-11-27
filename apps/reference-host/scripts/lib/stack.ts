/**
 * The demo stack's settings and generated secrets, shared by the Node parts of the stack
 * (scripts/setup.ts, scripts/run.ts, scripts/seed.ts) and by the exit-check scenario (e2e/).
 *
 * Settings: stack/.env.example, then stack/.env, then the environment (the order of
 * infra/test-env.ps1). Secrets: generated once into the data directory (`.stack/secrets.json`) and
 * kept as long as the stack's volumes; `stack.ps1 down -Volumes` removes both. Demo only.
 */
import { generateKeyPairSync, randomBytes, randomUUID, type JsonWebKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashSecret } from '@docedit/document-service';

export const APP_DIR = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const REPO_DIR = resolve(APP_DIR, '../..');
export const SEED_DIR = join(APP_DIR, 'seed');

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) throw new Error(`${path}: expected KEY=VALUE, found: ${line}`);
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export type Settings = Readonly<Record<string, string>>;

export function stackSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const s: Record<string, string> = {
    ...readEnvFile(join(APP_DIR, 'stack', '.env.example')),
    ...readEnvFile(join(APP_DIR, 'stack', '.env')),
  };
  for (const k of Object.keys(s)) {
    const v = env[k];
    if (v !== undefined && v !== '') s[k] = v;
  }
  return s;
}

export function setting(s: Settings, name: string): string {
  const v = s[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set (stack/.env.example)`);
  return v;
}

/** The data directory: DOCEDIT_DEMO_DATA, or `.stack/` in the app. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env['DOCEDIT_DEMO_DATA'] || join(APP_DIR, '.stack'));
}

export interface Tenant {
  id: string;
  name: string;
}

export function seedTenant(): Tenant {
  return JSON.parse(readFileSync(join(SEED_DIR, 'tenant.json'), 'utf8')) as Tenant;
}

/** The secrets of one stack's lifetime. Demo only: generated, never committed, never reused. */
export interface Secrets {
  'x-note': string;
  createdAt: string;
  apiKey: { id: string; secret: string; credential: string };
  /** The host's key for host-signed tokens (ES256). */
  hostSigning: JsonWebKey & { kid: string };
  hostPublic: JsonWebKey;
  /** The service's key for the tokens it mints (EdDSA). */
  serviceSigning: JsonWebKey & { kid: string };
  viewKey: string;
  cursorSecret: string;
}

export const SECRETS_FILE = 'secrets.json';

/**
 * What one long-running part is given (SEC-048 criterion 2; owner decision 107): the document
 * service holds its signing key, view key and cursor secret; the reference host (and the seed run,
 * which acts as the host) holds the API key and the host's signing key; the export worker holds no
 * generated secret. `secrets.json` is the operator's complete record and no part of the stack
 * reads it at run time.
 */
export type ServiceSecrets = Pick<
  Secrets,
  'x-note' | 'serviceSigning' | 'viewKey' | 'cursorSecret'
>;
export type HostSecrets = Pick<Secrets, 'x-note' | 'apiKey' | 'hostSigning'>;
export type SecretRole = 'service' | 'host';

/** The part of the secrets one role is given. */
export function secretsFor(role: 'service', secrets: Secrets): ServiceSecrets;
export function secretsFor(role: 'host', secrets: Secrets): HostSecrets;
export function secretsFor(role: SecretRole, secrets: Secrets): ServiceSecrets | HostSecrets {
  const note = secrets['x-note'];
  return role === 'service'
    ? {
        'x-note': note,
        serviceSigning: secrets.serviceSigning,
        viewKey: secrets.viewKey,
        cursorSecret: secrets.cursorSecret,
      }
    : { 'x-note': note, apiKey: secrets.apiKey, hostSigning: secrets.hostSigning };
}

/**
 * The directory that holds the secret files: DOCEDIT_DEMO_SECRETS, or the data directory. In the
 * containers of compose.json it is `/secrets`, and each long-running container mounts only its own
 * role's directory there; setup mounts all of them. Without it (stack.ps1 starts the parts as
 * processes of one user) the role directories sit next to `secrets.json`.
 */
export function secretsDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env['DOCEDIT_DEMO_SECRETS'] || dataDir(env));
}

/** The file of one role: `<secrets directory>/role-<role>/secrets.json`. */
export function roleSecretsFile(role: SecretRole, root = secretsDir()): string {
  return join(root, `role-${role}`, SECRETS_FILE);
}

/**
 * The secret of the host's webhook subscription (UX-105 criterion 1). The document service issues
 * it when the seed step registers the subscription, shows it once, and keeps only a reference, so
 * it cannot be generated by setup. The seed step writes it here, in the host's role directory and
 * beside (not inside) the role's secrets file, which setup rewrites; the host reads it at start
 * and puts it in `DOCEDIT_HOST_WEBHOOK_SECRETS`. Demo only, like every secret of the stack.
 */
export function webhookSecretFile(root = secretsDir()): string {
  return join(root, 'role-host', 'webhook-secret.json');
}

export async function readWebhookSecret(root = secretsDir()): Promise<string | undefined> {
  try {
    const v = JSON.parse(await readFile(webhookSecretFile(root), 'utf8')) as { secret?: unknown };
    return typeof v.secret === 'string' && v.secret !== '' ? v.secret : undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export async function writeWebhookSecret(secret: string, root = secretsDir()): Promise<void> {
  await writeSecretFile(webhookSecretFile(root), {
    'x-note':
      'Demo only. The signing secret of the host’s webhook subscription, issued by the document service when the seed step registered it. Removed with `stack.ps1 down -Volumes`.',
    secret,
  });
}

export async function readSecrets(dir = dataDir()): Promise<Secrets> {
  return JSON.parse(await readFile(join(dir, SECRETS_FILE), 'utf8')) as Secrets;
}

export async function readRoleSecrets(role: 'service', root?: string): Promise<ServiceSecrets>;
export async function readRoleSecrets(role: 'host', root?: string): Promise<HostSecrets>;
export async function readRoleSecrets(
  role: SecretRole,
  root?: string,
): Promise<ServiceSecrets | HostSecrets>;
export async function readRoleSecrets(
  role: SecretRole,
  root = secretsDir(),
): Promise<ServiceSecrets | HostSecrets> {
  return JSON.parse(await readFile(roleSecretsFile(role, root), 'utf8')) as
    ServiceSecrets | HostSecrets;
}

async function writeSecretFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

/** Writes each role's file under `root`, from the complete record. */
export async function writeRoleSecrets(secrets: Secrets, root = secretsDir()): Promise<void> {
  await writeSecretFile(roleSecretsFile('service', root), secretsFor('service', secrets));
  await writeSecretFile(roleSecretsFile('host', root), secretsFor('host', secrets));
}

/** The secrets of this data directory, generated the first time. */
export async function ensureSecrets(tenant: string, dir = dataDir(), root = dir): Promise<Secrets> {
  try {
    const existing = await readSecrets(root);
    await writeRoleSecrets(existing, root);
    return existing;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const host = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const service = generateKeyPairSync('ed25519');
  const secrets: Secrets = {
    'x-note':
      'Demo only. Generated by apps/reference-host/scripts/setup.ts for this stack and its volumes; `stack.ps1 down -Volumes` deletes it. Never reuse these values.',
    createdAt: new Date().toISOString(),
    // The API key format of ADR 0036: dsk_<tenant>_<key id>_<secret>.
    apiKey: { id, secret, credential: `dsk_${tenant}_${id}_${secret}` },
    hostSigning: {
      ...(host.privateKey.export({ format: 'jwk' }) as JsonWebKey),
      kid: 'refhost-demo-1',
    },
    hostPublic: host.publicKey.export({ format: 'jwk' }) as JsonWebKey,
    serviceSigning: {
      ...(service.privateKey.export({ format: 'jwk' }) as JsonWebKey),
      kid: `demo-service-${randomUUID().slice(0, 8)}`,
    },
    viewKey: randomBytes(32).toString('base64'),
    cursorSecret: randomBytes(32).toString('base64url'),
  };
  await writeSecretFile(join(root, SECRETS_FILE), secrets);
  await writeRoleSecrets(secrets, root);
  return secrets;
}

/** The issuer of host-signed tokens, registered with the tenant's key. */
export const HOST_ISSUER = 'docedit-reference-host';

export interface Endpoints {
  serviceUrl: string;
  hostUrl: string;
  /** The second origin of the host, for the PDF viewer's frame (FE-071). */
  viewerOrigin: string;
  s3Url: string;
  adminDatabaseUrl: (database: string) => string;
  serviceDatabaseUrl: string;
}

export function endpoints(s: Settings): Endpoints {
  const pgPort = setting(s, 'DOCEDIT_DEMO_PG_PORT');
  const db = setting(s, 'DOCEDIT_DEMO_PG_DATABASE');
  const enc = encodeURIComponent;
  return {
    serviceUrl: `http://127.0.0.1:${setting(s, 'DOCEDIT_DEMO_SERVICE_PORT')}`,
    hostUrl: `http://127.0.0.1:${setting(s, 'DOCEDIT_DEMO_HOST_PORT')}`,
    viewerOrigin: `http://localhost:${setting(s, 'DOCEDIT_DEMO_HOST_PORT')}`,
    s3Url: `http://127.0.0.1:${setting(s, 'DOCEDIT_DEMO_S3_PORT')}`,
    adminDatabaseUrl: (database) =>
      `postgres://${enc(setting(s, 'DOCEDIT_DEMO_PG_ADMIN_USER'))}:${enc(setting(s, 'DOCEDIT_DEMO_PG_ADMIN_PASSWORD'))}@127.0.0.1:${pgPort}/${enc(database)}`,
    serviceDatabaseUrl: `postgres://${enc(setting(s, 'DOCEDIT_DEMO_PG_SERVICE_USER'))}:${enc(setting(s, 'DOCEDIT_DEMO_PG_SERVICE_PASSWORD'))}@127.0.0.1:${pgPort}/${enc(db)}`,
  };
}

/**
 * The origins the tenant allows (05 §4; 10 §3.2): the host's page by its two loopback names. The
 * IPv6 literal `http://[::1]:port` is left out: the service's registry does not accept IPv6 hosts
 * in origins yet (reported to the main session).
 */
export function allowedOrigins(s: Settings): string[] {
  const port = setting(s, 'DOCEDIT_DEMO_HOST_PORT');
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

/**
 * The tenant registration file the document service applies at start (`DOCEDIT_TENANTS_FILE`,
 * BE-012; `applySeed` in @docedit/document-service). It holds the host's public key for host-signed
 * tokens, the host's API key as a SHA-256 hash of its secret, and the allowed origins. It never
 * holds a private key or a secret. `scripts/setup.ts` writes this value; the tests apply it to an
 * in-memory registry through the service's own parser.
 */
export interface TenantRegistration {
  tenants: Array<{
    id: string;
    name: string;
    keys: Array<{ kid: string; use: 'user'; alg: 'ES256'; jwk: JsonWebKey; issuer: string }>;
    apiKeys: Array<{ id: string; secretSha256: string; label: string }>;
    origins: string[];
  }>;
}

export function tenantRegistration(
  tenant: Tenant,
  secrets: Secrets,
  origins: readonly string[],
): TenantRegistration {
  return {
    tenants: [
      {
        id: tenant.id,
        name: tenant.name,
        keys: [
          {
            kid: secrets.hostSigning.kid,
            use: 'user',
            alg: 'ES256',
            jwk: secrets.hostPublic,
            issuer: HOST_ISSUER,
          },
        ],
        apiKeys: [
          {
            id: secrets.apiKey.id,
            secretSha256: hashSecret(secrets.apiKey.secret).toString('hex'),
            label: 'reference host (demo only)',
          },
        ],
        origins: [...origins],
      },
    ],
  };
}

function s3Env(s: Settings): Record<string, string> {
  return {
    DOCEDIT_S3_ENDPOINT: endpoints(s).s3Url,
    DOCEDIT_S3_REGION: setting(s, 'DOCEDIT_DEMO_S3_REGION'),
    DOCEDIT_S3_BUCKET: setting(s, 'DOCEDIT_DEMO_S3_BUCKET'),
    DOCEDIT_S3_ACCESS_KEY: setting(s, 'DOCEDIT_DEMO_S3_ACCESS_KEY'),
    DOCEDIT_S3_SECRET_KEY: setting(s, 'DOCEDIT_DEMO_S3_SECRET_KEY'),
  };
}

/** The path of the host's receiver (src/routes/webhooks/dep/+server.ts). */
export const WEBHOOK_PATH = '/webhooks/dep';

/**
 * The events the host's subscription asks for (UX-105 criterion 1): the workflow events that
 * invite, remind and record the outcome (send-for-completion.ts), and the comment and task events
 * of the notifications (UX-098; webhook-notifications.ts).
 */
export const WEBHOOK_EVENTS: readonly string[] = [
  'dep.workflow.participant_activated.v1',
  'dep.workflow.reminder_due.v1',
  'dep.workflow.completed.v1',
  'dep.workflow.finalised.v1',
  'dep.comment.mentioned.v1',
  'dep.task.assigned.v1',
];

/** Where the service delivers: the host's receiver. */
export function webhookTarget(s: Settings): string {
  return `${endpoints(s).hostUrl}${WEBHOOK_PATH}`;
}

/**
 * The one exception of the service's egress proxy (UX-105 criterion 2): the host's address and
 * port, exactly. The service accepts it only with DOCEDIT_ENVIRONMENT other than production.
 */
export function webhookAllow(s: Settings): string {
  return `127.0.0.1:${setting(s, 'DOCEDIT_DEMO_HOST_PORT')}`;
}

export type Role = 'service' | 'host' | 'worker';

/** What `roleEnv` is given: the role's secrets, and for the host the webhook secret the seed issued. */
export type RoleSecrets = Partial<Secrets> & { webhookSecret?: string };

/** The environment one part of the stack runs with. */
export function roleEnv(
  role: Role,
  s: Settings,
  secrets: RoleSecrets,
  dir = dataDir(),
): Record<string, string> {
  const need = <K extends keyof Secrets>(key: K): Secrets[K] => {
    const v = secrets[key];
    if (v === undefined) throw new Error(`the ${role} part is not given ${key}`);
    return v as Secrets[K];
  };
  const e = endpoints(s);
  const tenant = seedTenant();
  switch (role) {
    case 'service':
      return {
        DOCEDIT_LISTEN_HOST: '127.0.0.1',
        DOCEDIT_LISTEN_PORT: setting(s, 'DOCEDIT_DEMO_SERVICE_PORT'),
        DOCEDIT_PUBLIC_URL: e.serviceUrl,
        DOCEDIT_SERVICE_ID: setting(s, 'DOCEDIT_DEMO_SERVICE_ID'),
        DOCEDIT_DATABASE_URL: e.serviceDatabaseUrl,
        ...s3Env(s),
        DOCEDIT_SIGNING_JWK: JSON.stringify(need('serviceSigning')),
        DOCEDIT_TENANTS_FILE: join(dir, 'tenants.json'),
        DOCEDIT_VIEW_KEY: need('viewKey'),
        DOCEDIT_CURSOR_SECRET: need('cursorSecret'),
        DOCEDIT_NODE_ID: `${setting(s, 'DOCEDIT_DEMO_PROJECT')}-service-1`,
        // Webhook delivery to the reference host (UX-105). The figures are the demo's own test
        // values (stack/.env.example); the spec gives none (ADR 0146). The environment is not
        // production, which the exception below needs; nothing else of the service reads it.
        DOCEDIT_ENVIRONMENT: 'development',
        DOCEDIT_WEBHOOKS: 'true',
        DOCEDIT_WEBHOOK_REJECTED_WINDOW_MS: setting(s, 'DOCEDIT_DEMO_WEBHOOK_REJECTED_WINDOW_MS'),
        DOCEDIT_WEBHOOK_REJECTED_MAX: setting(s, 'DOCEDIT_DEMO_WEBHOOK_REJECTED_MAX'),
        DOCEDIT_WEBHOOK_TIMEOUT_MS: setting(s, 'DOCEDIT_DEMO_WEBHOOK_TIMEOUT_MS'),
        DOCEDIT_WEBHOOK_MAX_REDIRECTS: '0',
        DOCEDIT_WEBHOOK_RETRY_BASE_MS: setting(s, 'DOCEDIT_DEMO_WEBHOOK_RETRY_BASE_MS'),
        DOCEDIT_WEBHOOK_RETRY_FACTOR: setting(s, 'DOCEDIT_DEMO_WEBHOOK_RETRY_FACTOR'),
        DOCEDIT_DEMO_WEBHOOK_ALLOW: webhookAllow(s),
      };
    case 'host':
      return {
        DOCEDIT_HOST_ENDPOINT: e.serviceUrl,
        DOCEDIT_SERVICE_ID: setting(s, 'DOCEDIT_DEMO_SERVICE_ID'),
        DOCEDIT_HOST_TENANT: tenant.id,
        DOCEDIT_HOST_API_KEY: need('apiKey').credential,
        DOCEDIT_HOST_TOKENS: setting(s, 'DOCEDIT_DEMO_TOKENS'),
        DOCEDIT_HOST_TOKEN_SECONDS: setting(s, 'DOCEDIT_DEMO_TOKEN_SECONDS'),
        DOCEDIT_HOST_SIGNING_JWK: JSON.stringify(need('hostSigning')),
        DOCEDIT_HOST_ISSUER: HOST_ISSUER,
        DOCEDIT_HOST_DATA: dir,
        DOCEDIT_HOST_SEED: SEED_DIR,
        DOCEDIT_HOST_VIEWER_URL: `${e.viewerOrigin}/element/viewer/pdf-viewer.html`,
        DOCEDIT_HOST_PAGE_ORIGINS: allowedOrigins(s).join(','),
        DOCEDIT_HOST_EXPORT_ORIGINS: e.s3Url,
        DOCEDIT_HOST_ELEMENT_DIR: join(REPO_DIR, 'packages', 'element', 'dist', 'lib'),
        DOCEDIT_DEMO_HOST_PORT: setting(s, 'DOCEDIT_DEMO_HOST_PORT'),
        // Notifications go to the development mail sink (UX-098 criterion 5).
        DOCEDIT_HOST_SMTP: `127.0.0.1:${setting(s, 'DOCEDIT_DEMO_MAIL_SMTP_PORT')}`,
        DOCEDIT_HOST_PUBLIC_URL: e.hostUrl,
        // The signing secret of the subscription the seed step registered (UX-105 criterion 1).
        ...(secrets.webhookSecret ? { DOCEDIT_HOST_WEBHOOK_SECRETS: secrets.webhookSecret } : {}),
      };
    case 'worker': {
      const machine = s['DOCEDIT_PODMAN_MACHINE'];
      return {
        DOCEDIT_DATABASE_URL: e.serviceDatabaseUrl,
        ...s3Env(s),
        DOCEDIT_EXPORT_IMAGE: setting(s, 'DOCEDIT_EXPORT_IMAGE'),
        DOCEDIT_CONTAINER_CLI: setting(s, 'DOCEDIT_CONTAINER_CLI'),
        DOCEDIT_NODE_ID: `${setting(s, 'DOCEDIT_DEMO_PROJECT')}-export-1`,
        ...(machine ? { DOCEDIT_PODMAN_MACHINE: machine } : {}),
      };
    }
  }
}
