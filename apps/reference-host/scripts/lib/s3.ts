/**
 * The few S3 requests the stack's set-up makes (bucket, CORS rules), signed with AWS Signature
 * Version 4, path-style, as infra/test-env.ps1 does. The document service has its own client for
 * objects (services/document-service, objects/s3.ts); this one only prepares the bucket.
 */
import { createHash, createHmac } from 'node:crypto';

export interface S3Target {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
}

const sha256hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Uint8Array, data: string) =>
  createHmac('sha256', key).update(data, 'utf8').digest();

export async function s3Request(
  t: S3Target,
  method: string,
  path: string,
  opts: { query?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  const url = new URL(t.endpoint);
  const date = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const day = date.slice(0, 8);
  const body = opts.body ?? '';
  const payloadHash = sha256hex(body);
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': date,
  };
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
  const names = Object.keys(headers).sort();
  const canonical = [
    method,
    path,
    opts.query ?? '',
    names.map((n) => `${n}:${headers[n]!.trim()}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${day}/${t.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${t.secretKey}`, day), t.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  const send: Record<string, string> = { ...headers };
  delete send['host'];
  send['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${t.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  const res = await fetch(`${url.origin}${path}${opts.query ? `?${opts.query}` : ''}`, {
    method,
    headers: send,
    ...(body ? { body } : {}),
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

/** Creates the bucket, or leaves it when it exists. */
export async function ensureBucket(t: S3Target, bucket: string): Promise<'created' | 'exists'> {
  const r = await s3Request(t, 'PUT', `/${bucket}`);
  if (r.status === 200) return 'created';
  if (/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(r.text)) return 'exists';
  throw new Error(
    `S3: creating bucket ${bucket} failed with HTTP ${r.status}: ${r.text.slice(0, 200)}`,
  );
}

/**
 * Lets the PDF viewer's frame fetch exported files by their signed URLs (FE-071): CORS rules for
 * GET and HEAD from the host's origins, with the range headers PDF.js uses. Returns what the store
 * answered, since not every S3-compatible store implements bucket CORS.
 */
export async function allowViewerOrigins(
  t: S3Target,
  bucket: string,
  origins: readonly string[],
): Promise<{ ok: boolean; status: number; detail: string }> {
  const xml =
    '<CORSConfiguration><CORSRule>' +
    origins.map((o) => `<AllowedOrigin>${o}</AllowedOrigin>`).join('') +
    '<AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>' +
    '<AllowedHeader>*</AllowedHeader>' +
    '<ExposeHeader>Accept-Ranges</ExposeHeader><ExposeHeader>Content-Range</ExposeHeader>' +
    '<ExposeHeader>Content-Length</ExposeHeader><MaxAgeSeconds>300</MaxAgeSeconds>' +
    '</CORSRule></CORSConfiguration>';
  const md5 = createHash('md5').update(xml).digest('base64');
  const r = await s3Request(t, 'PUT', `/${bucket}`, {
    query: 'cors=',
    body: xml,
    headers: { 'content-md5': md5, 'content-type': 'application/xml' },
  });
  return { ok: r.status === 200, status: r.status, detail: r.text.slice(0, 200) };
}
