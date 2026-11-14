/**
 * An S3-compatible object store over fetch, signed with AWS Signature Version 4 (BE-003; 06 §4.2,
 * §14). Path-style requests, so any S3-compatible server works (the test environment runs the
 * Versity S3 Gateway, FND-010). Only what the service needs: put, get, head, delete, list, and
 * presigned GET URLs.
 *
 * Write-once (BE-003 criterion 3) sends `If-None-Match: *`, which S3 and compatible servers answer
 * with 412 when the key exists; the adapter also checks first, for a server that ignores the header.
 * The check and the write are then not atomic: ADR 0036 records it.
 */
import { createHash, createHmac } from 'node:crypto';
import { ObjectExistsError, ObjectStoreError, type ObjectStore, type PutOptions } from './store.ts';

export interface S3Settings {
  /** For example `http://127.0.0.1:57070`. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: () => number;
}

const sha256hex = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Uint8Array | string, data: string) =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding as SigV4 wants it: every byte but the unreserved characters. */
function encode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodePath(key: string): string {
  return key.split('/').map(encode).join('/');
}

function amzDate(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function xmlText(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export class S3ObjectStore implements ObjectStore {
  readonly #s: S3Settings;
  readonly #base: URL;
  readonly #now: () => number;

  constructor(settings: S3Settings) {
    this.#s = settings;
    this.#base = new URL(settings.endpoint);
    this.#now = settings.now ?? Date.now;
  }

  #signingKey(date: string): Buffer {
    const kDate = hmac(`AWS4${this.#s.secretAccessKey}`, date);
    return hmac(hmac(hmac(kDate, this.#s.region), 's3'), 'aws4_request');
  }

  #path(key: string | null): string {
    return `/${encode(this.#s.bucket)}${key === null ? '' : `/${encodePath(key)}`}`;
  }

  async #request(
    method: string,
    key: string | null,
    opts: {
      query?: Record<string, string>;
      body?: Uint8Array;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const now = this.#now();
    const date = amzDate(now);
    const day = date.slice(0, 8);
    const path = this.#path(key);
    const query = Object.entries(opts.query ?? {})
      .map(([k, v]) => [encode(k), encode(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const body = opts.body ?? new Uint8Array();
    const payloadHash = sha256hex(body);
    const headers: Record<string, string> = {
      host: this.#base.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': date,
    };
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
    const names = Object.keys(headers).sort();
    const canonical = [
      method,
      path,
      query,
      names.map((n) => `${n}:${headers[n]!.trim()}\n`).join(''),
      names.join(';'),
      payloadHash,
    ].join('\n');
    const scope = `${day}/${this.#s.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canonical)].join('\n');
    const signature = createHmac('sha256', this.#signingKey(day)).update(toSign).digest('hex');
    const send: Record<string, string> = { ...headers };
    delete send['host'];
    send['authorization'] =
      `AWS4-HMAC-SHA256 Credential=${this.#s.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    const url = `${this.#base.origin}${path}${query ? `?${query}` : ''}`;
    try {
      return await fetch(url, {
        method,
        headers: send,
        // The DOM typings accept only a view over an ArrayBuffer, not over a shared buffer.
        ...(opts.body ? { body: opts.body as Uint8Array<ArrayBuffer> } : {}),
      });
    } catch (e) {
      throw new ObjectStoreError(
        `object storage is unreachable (${e instanceof Error ? e.name : 'error'})`,
        0,
      );
    }
  }

  async #fail(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? 'unknown';
    throw new ObjectStoreError(`${what} failed with HTTP ${res.status} (${code})`, res.status);
  }

  async put(key: string, body: Uint8Array, opts: PutOptions = {}): Promise<void> {
    if (opts.ifAbsent && (await this.exists(key))) throw new ObjectExistsError(`${key} exists`);
    const headers: Record<string, string> = {
      'content-type': opts.contentType ?? 'application/octet-stream',
    };
    if (opts.ifAbsent) headers['if-none-match'] = '*';
    const res = await this.#request('PUT', key, { body, headers });
    if (res.status === 412 && opts.ifAbsent) {
      await res.arrayBuffer();
      throw new ObjectExistsError(`${key} exists`);
    }
    if (!res.ok) return this.#fail(res, 'PUT');
    await res.arrayBuffer();
  }

  /**
   * Writes an object under S3 Object Lock (HIS-036 criterion 4): in COMPLIANCE mode it cannot be
   * overwritten or deleted before `retainUntil` (Unix ms), by any credential, the operator's own
   * included. The bucket must have Object Lock enabled (`createBucket({ objectLock: true })`).
   * Sends Content-MD5, which the server requires for a put that carries lock parameters.
   */
  async putRetained(key: string, body: Uint8Array, retainUntil: number): Promise<void> {
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'content-md5': createHash('md5').update(body).digest('base64'),
      'x-amz-object-lock-mode': 'COMPLIANCE',
      'x-amz-object-lock-retain-until-date': new Date(retainUntil).toISOString(),
    };
    const res = await this.#request('PUT', key, { body, headers });
    if (!res.ok) return this.#fail(res, 'PUT');
    await res.arrayBuffer();
  }

  /**
   * Creates the bucket of these settings, with Object Lock when `objectLock` is set. Used by the
   * test environment and by setup tools; an operator creates the production bucket itself.
   */
  async createBucket(opts: { objectLock?: boolean } = {}): Promise<void> {
    const headers: Record<string, string> = {};
    if (opts.objectLock) headers['x-amz-bucket-object-lock-enabled'] = 'true';
    const res = await this.#request('PUT', null, { headers });
    if (!res.ok) return this.#fail(res, 'CREATE BUCKET');
    await res.arrayBuffer();
  }

  /** Deletes the bucket of these settings; it must be empty. A missing bucket is not an error. */
  async deleteBucket(): Promise<void> {
    const res = await this.#request('DELETE', null);
    if (!res.ok && res.status !== 404) return this.#fail(res, 'DELETE BUCKET');
    await res.arrayBuffer();
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.#request('GET', key);
    if (res.status === 404) {
      await res.arrayBuffer();
      return null;
    }
    if (!res.ok) return this.#fail(res, 'GET');
    return new Uint8Array(await res.arrayBuffer());
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.#request('HEAD', key);
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 404) return false;
    if (!res.ok) throw new ObjectStoreError(`HEAD failed with HTTP ${res.status}`, res.status);
    return true;
  }

  async delete(key: string): Promise<void> {
    const res = await this.#request('DELETE', key);
    if (!res.ok && res.status !== 404) return this.#fail(res, 'DELETE');
    await res.arrayBuffer();
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | null = null;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (token) query['continuation-token'] = token;
      const res = await this.#request('GET', null, { query });
      if (!res.ok) return this.#fail(res, 'LIST');
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) out.push(xmlText(m[1]!));
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      token = truncated
        ? xmlText(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '')
        : null;
    } while (token);
    return out.sort();
  }

  signedUrl(key: string, expiresAt: number): string {
    const now = this.#now();
    const seconds = Math.max(1, Math.min(604_800, Math.ceil((expiresAt - now) / 1000)));
    const date = amzDate(now);
    const day = date.slice(0, 8);
    const scope = `${day}/${this.#s.region}/s3/aws4_request`;
    const path = this.#path(key);
    const params: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.#s.accessKeyId}/${scope}`,
      'X-Amz-Date': date,
      'X-Amz-Expires': String(seconds),
      'X-Amz-SignedHeaders': 'host',
    };
    const query = Object.entries(params)
      .map(([k, v]) => `${encode(k)}=${encode(v)}`)
      .sort()
      .join('&');
    const canonical = [
      'GET',
      path,
      query,
      `host:${this.#base.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canonical)].join('\n');
    const signature = createHmac('sha256', this.#signingKey(day)).update(toSign).digest('hex');
    return `${this.#base.origin}${path}?${query}&X-Amz-Signature=${signature}`;
  }
}
