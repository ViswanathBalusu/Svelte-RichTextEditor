/**
 * A document service in memory (the real one, `startService` of @docedit/document-service) with a
 * registered tenant, an API key and the host's public key, and a host composed against it. Tests
 * of the host's server logic run on it without containers.
 */
import { generateKeyPairSync, randomUUID, type JsonWebKey } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configFromEnv,
  hashSecret,
  newApiKey,
  startService,
  type Service,
  type StartOptions,
} from '@docedit/document-service';
import type { HostConfig, TokenMode } from '../src/lib/server/config.ts';
import { SEED_DIR } from '../src/lib/server/config.ts';
import { composeHost, type Host } from '../src/lib/server/host.ts';

export const SERVICE_ID = 'docedit-reference-host-test';
export const HOST_ISSUER = 'docedit-reference-host-test-issuer';

export interface Harness {
  service: Service;
  host: Host;
  tenant: string;
  apiKey: string;
  rest: string;
  close(): Promise<void>;
}

/** A P-256 key pair as JWKs, as the stack generates for host-signed tokens (scripts/setup.ts). */
export function hostKeyPair(kid = 'host-test-1'): {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateJwk: { ...(privateKey.export({ format: 'jwk' }) as JsonWebKey), kid },
    publicJwk: publicKey.export({ format: 'jwk' }) as JsonWebKey,
  };
}

export async function startHarness(
  opts: {
    tokenMode?: TokenMode;
    tokenSeconds?: number;
    /** More options for the service, for a test that needs its sealing or job handlers (UX-099). */
    service?: Partial<Omit<StartOptions, 'config'>>;
    /** Settings of the service over the test defaults (for the job loop's pace, for example). */
    serviceConfig?: Partial<NonNullable<StartOptions['config']>>;
  } = {},
): Promise<Harness> {
  const service = await startService({
    ...(opts.service ?? {}),
    config: {
      ...configFromEnv({}),
      port: 0,
      workers: 1,
      serviceId: SERVICE_ID,
      ...(opts.serviceConfig ?? {}),
    },
  });
  const tenant = randomUUID();
  await service.parts.registry.putTenant(tenant, 'reference host test');
  const key = newApiKey(tenant);
  await service.parts.registry.addApiKey(tenant, {
    id: key.id,
    secretHash: hashSecret(key.secret),
  });
  const pair = hostKeyPair();
  await service.parts.registry.addKey(tenant, {
    kid: 'host-test-1',
    use: 'user',
    alg: 'ES256',
    jwk: pair.publicJwk,
    issuer: HOST_ISSUER,
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'docedit-refhost-'));
  const config: HostConfig = {
    endpoint: service.url,
    rest: `${service.url}/v1`,
    serviceId: SERVICE_ID,
    tenant,
    apiKey: key.credential,
    tokenMode: opts.tokenMode ?? 'service-minted',
    tokenSeconds: opts.tokenSeconds ?? 300,
    signing: { privateJwk: pair.privateJwk, kid: 'host-test-1', issuer: HOST_ISSUER },
    dataDir,
    seedDir: SEED_DIR,
    viewerUrl: null,
    pageOrigins: [],
    exportOrigins: [],
    elementDir: null,
  };
  const host = await composeHost(config);
  return {
    service,
    host,
    tenant,
    apiKey: key.credential,
    rest: `${service.url}/v1`,
    async close() {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** The decoded header and payload of a compact JWS. */
export function decodeJws(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const [h, p] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString('utf8')) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p!, 'base64url').toString('utf8')) as Record<string, unknown>,
  };
}
