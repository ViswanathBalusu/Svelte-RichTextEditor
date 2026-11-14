/**
 * Settings of the reference host's server (13 §11.1, §11.2; UX-092), from the environment. The
 * stack (scripts/run.ts) sets them from its settings and generated secrets. Demo only: a real host
 * keeps its service credential and its signing key in its own secret store.
 *
 * Nothing here is ever sent to the browser except `endpoint` and `viewerUrl`.
 */
import type { JsonWebKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** How the token endpoint obtains a user token (05 §3.1). */
export type TokenMode = 'service-minted' | 'host-signed';

export interface HostSigning {
  /** The private key as a JWK (ES256 here); it never leaves the host's server. */
  privateJwk: JsonWebKey;
  kid: string;
  /** The `iss` of host-signed tokens, registered with the tenant's key. */
  issuer: string;
}

export interface HostConfig {
  /** The document service's endpoint, as the browser reaches it: discovery is under it (05 §2). */
  endpoint: string;
  /** The REST base the host's server calls; the discovery document's `rest` (05 §6.1). */
  rest: string;
  /** The service identifier: the `aud` of host-signed tokens (05 §3.1). */
  serviceId: string;
  /** The tenant this host is registered as. */
  tenant: string;
  /** The service credential (05 §3.2): an API key. Never logged, never sent to a browser. */
  apiKey: string;
  tokenMode: TokenMode;
  /** Lifetime of user tokens in seconds; 05 §3.1 allows at most 900. */
  tokenSeconds: number;
  signing: HostSigning | null;
  /** Where the host keeps its catalogue (`catalogue.json`). */
  dataDir: string;
  /** The seed files: users.json, documents.json and the template contents. */
  seedDir: string;
  /**
   * The PDF viewer's page, served from another origin than the host page so that the frame is
   * cross-origin (FE-071; 09 §9.3 rule 7). Null: the element's default next to its module.
   */
  viewerUrl: string | null;
  /** The origins of the host's pages, which alone may frame the viewer. */
  pageOrigins: string[];
  /** Where exported files are fetched from by signed URL (the object store), for the viewer. */
  exportOrigins: string[];
  /** The element's distributable (`packages/element/dist/lib`), which the host serves. */
  elementDir: string | null;
}

/** 05 §3.1: `exp` at most 15 minutes after `iat`. */
export const MAX_TOKEN_SECONDS = 900;
/** The demo's default lifetime: a setting, not a measurement (ADR 0048). */
export const DEFAULT_TOKEN_SECONDS = 300;

export const SEED_DIR = fileURLToPath(new URL('../../../seed/', import.meta.url));

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set; start the host through the stack (scripts/run.ts)`);
  return v;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): HostConfig {
  const endpoint = required(env, 'DOCEDIT_HOST_ENDPOINT').replace(/\/+$/, '');
  const mode = env['DOCEDIT_HOST_TOKENS'] ?? 'service-minted';
  if (mode !== 'service-minted' && mode !== 'host-signed')
    throw new Error('DOCEDIT_HOST_TOKENS is service-minted or host-signed');
  const seconds = Number(env['DOCEDIT_HOST_TOKEN_SECONDS'] ?? DEFAULT_TOKEN_SECONDS);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TOKEN_SECONDS)
    throw new Error(`DOCEDIT_HOST_TOKEN_SECONDS is a whole number from 1 to ${MAX_TOKEN_SECONDS}`);
  const jwk = env['DOCEDIT_HOST_SIGNING_JWK'];
  let signing: HostSigning | null = null;
  if (jwk) {
    const parsed = JSON.parse(jwk) as JsonWebKey & { kid?: string };
    signing = {
      privateJwk: parsed,
      kid: parsed.kid ?? 'host-1',
      issuer: env['DOCEDIT_HOST_ISSUER'] ?? 'docedit-reference-host',
    };
  }
  if (mode === 'host-signed' && !signing)
    throw new Error('host-signed tokens need DOCEDIT_HOST_SIGNING_JWK');
  return {
    endpoint,
    rest: (env['DOCEDIT_HOST_REST'] ?? `${endpoint}/v1`).replace(/\/+$/, ''),
    serviceId: env['DOCEDIT_SERVICE_ID'] ?? endpoint,
    tenant: required(env, 'DOCEDIT_HOST_TENANT'),
    apiKey: required(env, 'DOCEDIT_HOST_API_KEY'),
    tokenMode: mode,
    tokenSeconds: seconds,
    signing,
    dataDir: required(env, 'DOCEDIT_HOST_DATA'),
    seedDir: env['DOCEDIT_HOST_SEED'] ?? SEED_DIR,
    viewerUrl: env['DOCEDIT_HOST_VIEWER_URL'] || null,
    pageOrigins: list(env['DOCEDIT_HOST_PAGE_ORIGINS']),
    exportOrigins: list(env['DOCEDIT_HOST_EXPORT_ORIGINS']),
    elementDir: env['DOCEDIT_HOST_ELEMENT_DIR'] || null,
  };
}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
