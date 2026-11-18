/**
 * Short-lived signed URLs of the asset origin (BE-045 criteria 2 and 3; SEC-046 criteria 2 to 4;
 * 10 §3.7 "signed URLs are short-lived, scoped to one object, and issued only after a permission
 * check"). The control plane signs a URL after its permission check (05 §6.2
 * `POST /documents/{id}/assets/resolve`); the asset origin (origin.ts) checks it and serves the one
 * object it names. The signature covers the tenant, the object's hash, its kind and the expiry, so
 * changing any part of the path or the query fails the check. Keys have identifiers, so a key can
 * be rotated while URLs signed with the previous one run out.
 *
 *   {origin}/a/{tenant}/{sha256}.{ext}?exp={unix seconds}&kid={key id}&sig={base64url HMAC-SHA256}
 *
 * The results of an export job are served from the same origin (SEC-036 criterion 6; owner decision
 * 66 of 2026-11-15: the asset origin, not presigned store URLs), under their own path and with their
 * own signature domain, so an asset URL is never valid for a result or the other way round:
 *
 *   {origin}/e/{tenant}/{job}/{name}?exp=...&kid=...&sig=...
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isSha256, isUuid } from './keys.ts';
import { DOCX, GIF, JPEG, PDF, PNG, SVG } from './sandbox/types.ts';

export interface AssetUrlKey {
  /** Letters, digits, `_` and `-`, at most 32. */
  id: string;
  /** At least 32 bytes. */
  secret: Uint8Array;
}

export interface AssetUrlKeys {
  /** Signs new URLs. */
  current: AssetUrlKey;
  /** Still accepted, while URLs they signed run out. */
  previous?: readonly AssetUrlKey[];
}

export interface ServedKind {
  ext: string;
  contentType: string;
  /** `inline` for raster images; `attachment` for everything a browser could render as a page. */
  disposition: 'inline' | 'attachment';
}

/** The fixed content type and disposition per kind (BE-045 criterion 4; SEC-040 criterion 4). */
export const SERVED: Readonly<Record<string, ServedKind>> = {
  png: { ext: 'png', contentType: PNG, disposition: 'inline' },
  jpg: { ext: 'jpg', contentType: JPEG, disposition: 'inline' },
  gif: { ext: 'gif', contentType: GIF, disposition: 'inline' },
  svg: { ext: 'svg', contentType: SVG, disposition: 'attachment' },
  pdf: { ext: 'pdf', contentType: PDF, disposition: 'attachment' },
  docx: { ext: 'docx', contentType: DOCX, disposition: 'attachment' },
};

const EXT_OF: Readonly<Record<string, string>> = {
  [PNG]: 'png',
  [JPEG]: 'jpg',
  [GIF]: 'gif',
  [SVG]: 'svg',
  [PDF]: 'pdf',
  [DOCX]: 'docx',
};

/** Settings, not measurements (ADR 0043). The control plane's signed URLs default to 300 s too. */
export const URL_DEFAULTS = {
  lifetimeMs: 300_000,
  quantumMs: 60_000,
  maxLifetimeMs: 3_600_000,
} as const;

/**
 * The fixed content type of each file an export job writes, by extension (SEC-036 criterion 6). The
 * type never comes from the store or the request, and every result is a download: `attachment`,
 * so that a browser never renders a result as a page of this origin.
 */
export const EXPORT_SERVED: Readonly<Record<string, ServedKind>> = {
  pdf: { ext: 'pdf', contentType: PDF, disposition: 'attachment' },
  json: { ext: 'json', contentType: 'application/json', disposition: 'attachment' },
  log: { ext: 'log', contentType: 'text/plain; charset=utf-8', disposition: 'attachment' },
  txt: { ext: 'txt', contentType: 'text/plain; charset=utf-8', disposition: 'attachment' },
  tar: { ext: 'tar', contentType: 'application/x-tar', disposition: 'attachment' },
  html: { ext: 'html', contentType: 'text/html; charset=utf-8', disposition: 'attachment' },
  md: { ext: 'md', contentType: 'text/markdown; charset=utf-8', disposition: 'attachment' },
};

const EXPORT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.([a-z]{2,4})$/;

/** The served kind of an export file name, or null when it has none (and is never served). */
export function exportKindOf(name: string): ServedKind | null {
  const m = EXPORT_NAME.exec(name);
  return m ? (EXPORT_SERVED[m[1]!] ?? null) : null;
}

function checkKey(k: AssetUrlKey): void {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(k.id)) throw new RangeError('a URL key identifier');
  if (k.secret.length < 32) throw new RangeError('a URL key secret has at least 32 bytes');
}

function mac(key: AssetUrlKey, tenant: string, sha256: string, ext: string, exp: number): Buffer {
  return createHmac('sha256', key.secret)
    .update(`docedit-asset-url-v1\n${tenant}\n${sha256}\n${ext}\n${exp}`, 'utf8')
    .digest();
}

function exportMac(
  key: AssetUrlKey,
  tenant: string,
  job: string,
  name: string,
  exp: number,
): Buffer {
  return createHmac('sha256', key.secret)
    .update(`docedit-export-url-v1\n${tenant}\n${job}\n${name}\n${exp}`, 'utf8')
    .digest();
}

/**
 * An expiry `lifetimeMs` after the start of the current `quantumMs` window, so that every request
 * in one window gets the same URL and the browser cache can serve it.
 */
export function assetUrlExpiry(
  now: number,
  lifetimeMs: number = URL_DEFAULTS.lifetimeMs,
  quantumMs: number = URL_DEFAULTS.quantumMs,
): number {
  if (!(quantumMs > 0) || !(lifetimeMs > quantumMs))
    throw new RangeError('the lifetime must be longer than the window');
  return Math.floor(now / quantumMs) * quantumMs + lifetimeMs;
}

/** A URL of one asset object, valid until `expiresAt` (Unix ms, rounded up to a second). */
export function signAssetUrl(args: {
  origin: string;
  tenant: string;
  sha256: string;
  mime: string;
  expiresAt: number;
  keys: AssetUrlKeys;
}): string {
  if (!isUuid(args.tenant)) throw new RangeError('a tenant identifier is a lower-case UUID');
  if (!isSha256(args.sha256)) throw new RangeError('an asset hash is a lower-case SHA-256');
  const ext = EXT_OF[args.mime];
  if (!ext) throw new RangeError(`no served kind for ${args.mime}`);
  checkKey(args.keys.current);
  const origin = new URL(args.origin);
  if (origin.pathname !== '/' || origin.search || origin.hash)
    throw new RangeError('the asset origin is a bare origin');
  const exp = Math.ceil(args.expiresAt / 1000);
  const sig = mac(args.keys.current, args.tenant, args.sha256, ext, exp).toString('base64url');
  return `${origin.origin}/a/${args.tenant}/${args.sha256}.${ext}?exp=${exp}&kid=${args.keys.current.id}&sig=${sig}`;
}

export type UrlCheck =
  | { ok: true; tenant: string; sha256: string; kind: ServedKind; expiresAt: number }
  | {
      ok: false;
      reason: 'not_found' | 'malformed' | 'expired' | 'too_long' | 'unknown_key' | 'bad_signature';
    };

const PATH =
  /^\/a\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{64})\.([a-z]{3,4})$/;

/** Checks the path and query of a request to the asset origin. */
export function verifyAssetUrl(
  pathAndQuery: string,
  keys: AssetUrlKeys,
  now: number,
  maxLifetimeMs: number = URL_DEFAULTS.maxLifetimeMs,
): UrlCheck {
  const q = pathAndQuery.indexOf('?');
  const path = q < 0 ? pathAndQuery : pathAndQuery.slice(0, q);
  const m = PATH.exec(path);
  if (!m) return { ok: false, reason: 'not_found' };
  const kind = SERVED[m[3]!];
  if (!kind) return { ok: false, reason: 'not_found' };
  const checked = checkQuery(pathAndQuery, q, keys, now, maxLifetimeMs);
  if ('reason' in checked) return { ok: false, reason: checked.reason };
  const expected = mac(checked.key, m[1]!, m[2]!, kind.ext, checked.exp);
  if (!sameMac(checked.sig, expected)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, tenant: m[1]!, sha256: m[2]!, kind, expiresAt: checked.exp * 1000 };
}

type QueryReason = Exclude<
  Extract<UrlCheck, { ok: false }>['reason'],
  'not_found' | 'bad_signature'
>;

/** The `exp`, `kid` and `sig` of a request's query, checked for form, expiry and key. */
function checkQuery(
  pathAndQuery: string,
  q: number,
  keys: AssetUrlKeys,
  now: number,
  maxLifetimeMs: number,
): { exp: number; key: AssetUrlKey; sig: string } | { reason: QueryReason } {
  if (q < 0) return { reason: 'malformed' };
  // Exactly exp, kid and sig, once each, in any order, and nothing else.
  const params = new Map<string, string>();
  for (const part of pathAndQuery.slice(q + 1).split('&')) {
    const e = part.indexOf('=');
    if (e < 1) return { reason: 'malformed' };
    const k = part.slice(0, e);
    if (params.has(k) || !['exp', 'kid', 'sig'].includes(k)) return { reason: 'malformed' };
    params.set(k, part.slice(e + 1));
  }
  const expText = params.get('exp');
  const kid = params.get('kid');
  const sig = params.get('sig');
  if (!expText || !kid || !sig || !/^\d{1,12}$/.test(expText) || !/^[A-Za-z0-9_-]{43}$/.test(sig))
    return { reason: 'malformed' };
  const exp = Number(expText);
  if (exp * 1000 <= now) return { reason: 'expired' };
  if (exp * 1000 - now > maxLifetimeMs) return { reason: 'too_long' };
  const key = [keys.current, ...(keys.previous ?? [])].find((k) => k.id === kid);
  if (!key) return { reason: 'unknown_key' };
  return { exp, key, sig };
}

function sameMac(sig: string, expected: Buffer): boolean {
  const given = Buffer.from(sig, 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A URL of one result file of an export job, valid until `expiresAt` (Unix ms, rounded up). */
export function signExportUrl(args: {
  origin: string;
  tenant: string;
  job: string;
  name: string;
  expiresAt: number;
  keys: AssetUrlKeys;
}): string {
  if (!isUuid(args.tenant)) throw new RangeError('a tenant identifier is a lower-case UUID');
  if (!isUuid(args.job)) throw new RangeError('a job identifier is a lower-case UUID');
  if (!exportKindOf(args.name)) throw new RangeError(`no served kind for ${args.name}`);
  checkKey(args.keys.current);
  const origin = new URL(args.origin);
  if (origin.pathname !== '/' || origin.search || origin.hash)
    throw new RangeError('the asset origin is a bare origin');
  const exp = Math.ceil(args.expiresAt / 1000);
  const sig = exportMac(args.keys.current, args.tenant, args.job, args.name, exp).toString(
    'base64url',
  );
  return `${origin.origin}/e/${args.tenant}/${args.job}/${args.name}?exp=${exp}&kid=${args.keys.current.id}&sig=${sig}`;
}

export type ExportUrlCheck =
  | {
      ok: true;
      tenant: string;
      job: string;
      name: string;
      kind: ServedKind;
      expiresAt: number;
    }
  | { ok: false; reason: Extract<UrlCheck, { ok: false }>['reason'] };

const EXPORT_PATH =
  /^\/e\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([A-Za-z0-9_.-]{1,70})$/;

/** Checks the path and query of a request for a result file to the asset origin. */
export function verifyExportUrl(
  pathAndQuery: string,
  keys: AssetUrlKeys,
  now: number,
  maxLifetimeMs: number = URL_DEFAULTS.maxLifetimeMs,
): ExportUrlCheck {
  const q = pathAndQuery.indexOf('?');
  const path = q < 0 ? pathAndQuery : pathAndQuery.slice(0, q);
  const m = EXPORT_PATH.exec(path);
  if (!m) return { ok: false, reason: 'not_found' };
  const kind = exportKindOf(m[3]!);
  if (!kind) return { ok: false, reason: 'not_found' };
  const checked = checkQuery(pathAndQuery, q, keys, now, maxLifetimeMs);
  if ('reason' in checked) return { ok: false, reason: checked.reason };
  const expected = exportMac(checked.key, m[1]!, m[2]!, m[3]!, checked.exp);
  if (!sameMac(checked.sig, expected)) return { ok: false, reason: 'bad_signature' };
  return {
    ok: true,
    tenant: m[1]!,
    job: m[2]!,
    name: m[3]!,
    kind,
    expiresAt: checked.exp * 1000,
  };
}
