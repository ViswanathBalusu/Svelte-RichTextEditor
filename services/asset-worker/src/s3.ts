/**
 * An S3-compatible client over fetch, signed with AWS Signature Version 4, path-style, for the
 * asset worker (06 §4.2, §4.4). It reads quarantined uploads with a size bound, writes final assets
 * once with a fixed content type, deletes quarantined uploads, and pre-signs the size-bound upload
 * of BE-042: the `content-length` header is part of the signature, so the store refuses a body of
 * any other size (tested against the Versity S3 Gateway of the test environment, FND-010).
 */
import { createHash, createHmac } from 'node:crypto';
import {
  ObjectStoreUnavailable,
  ObjectTooLarge,
  type AssetObjects,
  type PutOptions,
} from './objects.ts';

export interface S3Settings {
  /** For example `http://127.0.0.1:57070`. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: () => number;
}

const sha256hex = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');
const hmac = (key: Uint8Array | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding as Signature Version 4 wants it. */
function encode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function amzDate(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  /** Headers the client must send exactly; `content-length` is signed. */
  headers: { 'content-length': string };
  /** Unix ms. */
  expiresAt: number;
}

export class S3AssetObjects implements AssetObjects {
  readonly #s: S3Settings;
  readonly #base: URL;
  readonly #now: () => number;

  constructor(settings: S3Settings) {
    this.#s = settings;
    this.#base = new URL(settings.endpoint);
    this.#now = settings.now ?? Date.now;
  }

  #key(date: string): Buffer {
    return hmac(
      hmac(hmac(hmac(`AWS4${this.#s.secretAccessKey}`, date), this.#s.region), 's3'),
      'aws4_request',
    );
  }

  #path(key: string): string {
    if (key.length === 0 || key.includes('..') || key.startsWith('/'))
      throw new RangeError('an object key');
    return `/${encode(this.#s.bucket)}/${key.split('/').map(encode).join('/')}`;
  }

  async #request(
    method: string,
    key: string,
    body?: Uint8Array,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const now = this.#now();
    const date = amzDate(now);
    const day = date.slice(0, 8);
    const path = this.#path(key);
    const payloadHash = sha256hex(body ?? new Uint8Array());
    const headers: Record<string, string> = {
      host: this.#base.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': date,
    };
    for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = v;
    const names = Object.keys(headers).sort();
    const canonical = [
      method,
      path,
      '',
      names.map((n) => `${n}:${headers[n]!.trim()}\n`).join(''),
      names.join(';'),
      payloadHash,
    ].join('\n');
    const scope = `${day}/${this.#s.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canonical)].join('\n');
    const signature = createHmac('sha256', this.#key(day)).update(toSign).digest('hex');
    const send: Record<string, string> = { ...headers };
    delete send['host'];
    send['authorization'] =
      `AWS4-HMAC-SHA256 Credential=${this.#s.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    try {
      return await fetch(`${this.#base.origin}${path}`, {
        method,
        headers: send,
        // The DOM typings accept only a view over an ArrayBuffer, not over a shared buffer.
        ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}),
      });
    } catch (e) {
      throw new ObjectStoreUnavailable(
        `object storage is unreachable (${e instanceof Error ? e.name : 'error'})`,
        0,
      );
    }
  }

  async #fail(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]{1,64})<\/Code>/.exec(text)?.[1] ?? 'unknown';
    throw new ObjectStoreUnavailable(
      `${what} failed with HTTP ${res.status} (${code})`,
      res.status,
    );
  }

  async get(key: string, maxBytes: number): Promise<Uint8Array | null> {
    const res = await this.#request('GET', key);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) return this.#fail(res, 'GET');
    const declared = Number(res.headers.get('content-length') ?? 'NaN');
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel();
      throw new ObjectTooLarge(`${key} is larger than ${maxBytes} bytes`);
    }
    const reader = res.body?.getReader();
    if (!reader) return new Uint8Array();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ObjectTooLarge(`${key} is larger than ${maxBytes} bytes`);
      }
      parts.push(value);
    }
    const out = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  async head(key: string): Promise<{ bytes: number } | null> {
    const res = await this.#request('HEAD', key);
    await res.body?.cancel();
    if (res.status === 404) return null;
    if (!res.ok)
      throw new ObjectStoreUnavailable(`HEAD failed with HTTP ${res.status}`, res.status);
    return { bytes: Number(res.headers.get('content-length') ?? '0') };
  }

  async put(key: string, body: Uint8Array, opts: PutOptions): Promise<'written' | 'exists'> {
    // Check first, for servers that ignore If-None-Match; the header covers the race where they do.
    if (opts.ifAbsent && (await this.head(key))) return 'exists';
    const headers: Record<string, string> = { 'content-type': opts.contentType };
    if (opts.cacheControl) headers['cache-control'] = opts.cacheControl;
    if (opts.ifAbsent) headers['if-none-match'] = '*';
    const res = await this.#request('PUT', key, body, headers);
    if (res.status === 412 && opts.ifAbsent) {
      await res.body?.cancel();
      return 'exists';
    }
    if (!res.ok) return this.#fail(res, 'PUT');
    await res.body?.cancel();
    return 'written';
  }

  async delete(key: string): Promise<void> {
    const res = await this.#request('DELETE', key);
    if (!res.ok && res.status !== 404) return this.#fail(res, 'DELETE');
    await res.body?.cancel();
  }

  #presign(
    method: 'PUT' | 'GET',
    key: string,
    seconds: number,
    signed: Record<string, string>,
  ): string {
    const now = this.#now();
    const date = amzDate(now);
    const day = date.slice(0, 8);
    const scope = `${day}/${this.#s.region}/s3/aws4_request`;
    const path = this.#path(key);
    const headers: Record<string, string> = { host: this.#base.host, ...signed };
    const names = Object.keys(headers).sort();
    const params: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.#s.accessKeyId}/${scope}`,
      'X-Amz-Date': date,
      'X-Amz-Expires': String(seconds),
      'X-Amz-SignedHeaders': names.join(';'),
    };
    const query = Object.entries(params)
      .map(([k, v]) => `${encode(k)}=${encode(v)}`)
      .sort()
      .join('&');
    const canonical = [
      method,
      path,
      query,
      names.map((n) => `${n}:${headers[n]}\n`).join(''),
      names.join(';'),
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canonical)].join('\n');
    const signature = createHmac('sha256', this.#key(day)).update(toSign).digest('hex');
    return `${this.#base.origin}${path}?${query}&X-Amz-Signature=${signature}`;
  }

  /**
   * A pre-signed upload of exactly `bytes` bytes to `key`, valid for `seconds` (BE-042 criterion 3).
   * The size is signed, so a larger or smaller body fails the signature check.
   */
  presignUpload(key: string, bytes: number, seconds: number): PresignedUpload {
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      throw new RangeError('an upload has a positive size');
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 604_800)
      throw new RangeError('an upload lifetime in seconds');
    const length = String(bytes);
    return {
      url: this.#presign('PUT', key, seconds, { 'content-length': length }),
      method: 'PUT',
      headers: { 'content-length': length },
      expiresAt: this.#now() + seconds * 1000,
    };
  }

  /** A pre-signed read of `key`, valid for `seconds` (for workers that cannot hold credentials). */
  presignRead(key: string, seconds: number): string {
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 604_800)
      throw new RangeError('a lifetime in seconds');
    return this.#presign('GET', key, seconds, {});
  }
}
