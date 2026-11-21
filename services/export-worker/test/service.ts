/**
 * The document service as the end-to-end tests reach it (EXP-001): an in-process service on a free
 * port, called over real HTTP, with a tenant whose host key signs user tokens and an API key, all
 * generated here (test values only). Storage is in memory; objects go to the integration
 * environment's S3 store when it is up (infra/test-env.ps1), so that signed URLs can be fetched,
 * and stay in memory otherwise. The export worker runs beside it on the service's own queue and
 * stores, as `pnpm --filter @docedit/export-worker start` does on PostgreSQL.
 */
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  configFromEnv,
  hashSecret,
  memoryParts,
  newApiKey,
  S3ObjectStore,
  signingKey,
  startService,
  type S3Settings,
  type Service,
  type ServiceConfig,
} from '@docedit/document-service';
import { uuid7 } from '@docedit/model';

const CONTAINERS = fileURLToPath(new URL('../../../infra/containers/', import.meta.url));

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

/** The integration environment's settings: .env.example, then .env, then the environment. */
export function testSettings(): Record<string, string> {
  const s = { ...readEnvFile(CONTAINERS + '.env.example'), ...readEnvFile(CONTAINERS + '.env') };
  for (const k of Object.keys(s)) {
    const v = process.env[k];
    if (v) s[k] = v;
  }
  return s;
}

/** The S3 store of the integration environment, or null when it does not answer. */
export async function testS3(): Promise<S3Settings | null> {
  const s = testSettings();
  if (!s['DOCEDIT_S3_HOST']) return null;
  const settings: S3Settings = {
    endpoint: `http://${s['DOCEDIT_S3_HOST']}:${s['DOCEDIT_S3_PORT']}`,
    region: s['DOCEDIT_S3_REGION'] ?? 'us-east-1',
    bucket: s['DOCEDIT_S3_BUCKET'] ?? 'docedit-test',
    accessKeyId: s['DOCEDIT_S3_ACCESS_KEY'] ?? '',
    secretAccessKey: s['DOCEDIT_S3_SECRET_KEY'] ?? '',
  };
  try {
    const store = new S3ObjectStore(settings);
    await store.exists(`health/${randomUUID()}`);
    return settings;
  } catch {
    return null;
  }
}

export interface CallResult {
  status: number;
  headers: Headers;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
  json: any;
  text: string;
}

export interface TestService {
  service: Service;
  tenant: string;
  apiKey: string;
  /** Whether objects are in the S3 store (signed URLs can be fetched over HTTP). */
  s3: boolean;
  userToken(docs: Record<string, string>, sub?: string): string;
  call(
    method: string,
    path: string,
    opts?: { token?: string; body?: unknown },
  ): Promise<CallResult>;
  createDocument(content: unknown, title?: string): Promise<string>;
  close(): Promise<void>;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function jws(header: object, payload: object, key: KeyObject): string {
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  return `${input}.${b64(sign(null, Buffer.from(input), key))}`;
}

/**
 * `config`: settings of the service a test needs other than the defaults, for example a short
 * preview window (`previewWindowMs`), so that a test of two previews need not wait ten seconds.
 */
export async function startTestService(
  opts: { config?: Partial<ServiceConfig> } = {},
): Promise<TestService> {
  const s3 = await testS3();
  // Objects in the S3 store when it is up: a part passed here wins over the service's own choice.
  const parts = { ...memoryParts(), ...(s3 ? { objects: new S3ObjectStore(s3) } : {}) };
  const service = await startService({
    config: { ...configFromEnv({}), port: 0, workers: 1, s3, ...opts.config },
    parts,
    signing: signingKey(undefined, 'export-e2e'),
  });
  const tenant = randomUUID();
  await parts.registry.putTenant(tenant, 'Export test tenant');
  const pair = generateKeyPairSync('ed25519');
  const x = (pair.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const kid = `k-${randomUUID()}`;
  await parts.registry.addKey(tenant, {
    kid,
    use: 'user',
    alg: 'EdDSA',
    jwk: { kty: 'OKP', crv: 'Ed25519', x },
  });
  const key = newApiKey(tenant);
  await parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });
  const t: TestService = {
    service,
    tenant,
    apiKey: key.credential,
    s3: s3 !== null,
    userToken(docs, sub = 'alice') {
      const iat = Math.floor(Date.now() / 1000);
      return jws(
        { alg: 'EdDSA', typ: 'JWT', kid },
        {
          iss: 'https://host.example.test',
          aud: service.url,
          iat,
          exp: iat + 600,
          jti: uuid7(),
          tid: tenant,
          sub,
          docs,
        },
        pair.privateKey,
      );
    },
    async call(method, path, o = {}) {
      const headers: Record<string, string> = {};
      if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
      if (o.body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(`${service.url}${path}`, {
        method,
        headers,
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      return { status: res.status, headers: res.headers, text, json };
    },
    async createDocument(content, title = 'Export demonstration') {
      const r = await t.call('POST', '/v1/documents', {
        token: t.apiKey,
        body: { content, title },
      });
      if (r.status !== 201) throw new Error(`create failed: ${r.status} ${r.text}`);
      return r.json.id as string;
    },
    close: () => service.close(),
  };
  return t;
}
