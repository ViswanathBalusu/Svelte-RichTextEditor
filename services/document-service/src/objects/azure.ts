/**
 * An Azure Blob Storage object store over fetch (BE-004; 06 §14). It implements the same
 * `ObjectStore` port as the S3 adapter, so `TenantObjects`, the key layout of 06 §4.2 and the
 * checkpoint and asset stores work unchanged. Requests are signed with Shared Key; signed URLs are
 * service SAS URLs (read only, until `expiresAt`). Path-style URLs, so the Azurite emulator works
 * as well as an Azure account (`https://{account}.blob.core.windows.net`).
 *
 * Write-once (BE-004 criterion 3) sends `If-None-Match: *`. Azure applies that condition to the
 * write itself, so the check and the write are atomic here, unlike the S3 adapter (ADR 0036).
 */
import { createHmac } from 'node:crypto';
import { ObjectExistsError, ObjectStoreError, type ObjectStore, type PutOptions } from './store.ts';

export interface AzureBlobSettings {
  /**
   * The service endpoint: `https://{account}.blob.core.windows.net`, or for the Azurite emulator
   * `http://127.0.0.1:10000/devstoreaccount1`.
   */
  endpoint: string;
  account: string;
  /** The account key, base64, as Azure shows it. */
  accountKey: string;
  container: string;
  now?: () => number;
}

const API_VERSION = '2021-08-06';

const hmacB64 = (key: string, data: string): string =>
  createHmac('sha256', Buffer.from(key, 'base64')).update(data, 'utf8').digest('base64');

/** Percent-encodes each segment of a blob name; the `/` separators are kept. */
function encodeName(name: string): string {
  return name
    .split('/')
    .map((s) =>
      encodeURIComponent(s).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

function xmlText(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export class AzureBlobObjectStore implements ObjectStore {
  readonly #s: AzureBlobSettings;
  readonly #origin: string;
  /** The path of the endpoint without a trailing slash, for example `/devstoreaccount1` or empty. */
  readonly #basePath: string;
  readonly #now: () => number;

  constructor(settings: AzureBlobSettings) {
    this.#s = settings;
    const url = new URL(settings.endpoint);
    this.#origin = url.origin;
    this.#basePath = url.pathname.replace(/\/+$/, '');
    this.#now = settings.now ?? Date.now;
  }

  /** The URL path of the container, or of one blob in it, as sent on the wire. */
  #wirePath(name: string | null): string {
    return `${this.#basePath}/${encodeURIComponent(this.#s.container)}${name === null ? '' : `/${encodeName(name)}`}`;
  }

  /**
   * The Shared Key string to sign (the Blob service rules): the verb, eleven standard headers
   * (only Content-Length and Content-Type and If-None-Match are used here), the canonical x-ms
   * headers, then the canonical resource: `/{account}` and the URL path decoded, then the query
   * parameters in lower case.
   */
  #stringToSign(
    method: string,
    name: string | null,
    headers: Record<string, string>,
    query: Record<string, string>,
    contentLength: number,
  ): string {
    const xms = Object.keys(headers)
      .filter((n) => n.startsWith('x-ms-'))
      .sort()
      .map((n) => `${n}:${headers[n]!.trim()}\n`)
      .join('');
    const decodedPath = `${this.#basePath}/${this.#s.container}${name === null ? '' : `/${name}`}`;
    let resource = `/${this.#s.account}${decodedPath}`;
    const params = Object.entries(query)
      .map(([k, v]) => [k.toLowerCase(), v] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [k, v] of params) resource += `\n${k}:${v}`;
    const standard = [
      method,
      '', // Content-Encoding
      '', // Content-Language
      contentLength > 0 ? String(contentLength) : '',
      '', // Content-MD5
      headers['content-type'] ?? '',
      '', // Date (x-ms-date is sent instead)
      '', // If-Modified-Since
      '', // If-Match
      headers['if-none-match'] ?? '',
      '', // If-Unmodified-Since
      '', // Range
    ].join('\n');
    return `${standard}\n${xms}${resource}`;
  }

  #query(query: Record<string, string>): string {
    return Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  async #request(
    method: string,
    name: string | null,
    opts: {
      query?: Record<string, string>;
      body?: Uint8Array;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const query = opts.query ?? {};
    const body = opts.body;
    const contentLength = body ? body.byteLength : 0;
    const headers: Record<string, string> = {
      'x-ms-date': new Date(this.#now()).toUTCString(),
      'x-ms-version': API_VERSION,
    };
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
    if (body) headers['content-length'] = String(contentLength);
    const signature = hmacB64(
      this.#s.accountKey,
      this.#stringToSign(method, name, headers, query, contentLength),
    );
    const send: Record<string, string> = { ...headers };
    send['authorization'] = `SharedKey ${this.#s.account}:${signature}`;
    const qs = this.#query(query);
    const url = `${this.#origin}${this.#wirePath(name)}${qs ? `?${qs}` : ''}`;
    try {
      return await fetch(url, {
        method,
        headers: send,
        // The DOM typings accept only a view over an ArrayBuffer, not over a shared buffer.
        ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}),
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

  /** Creates the container of these settings; an existing one is not an error. */
  async createContainer(): Promise<void> {
    const res = await this.#request('PUT', null, { query: { restype: 'container' } });
    if (res.status === 409) {
      await res.arrayBuffer().catch(() => undefined);
      return;
    }
    if (!res.ok) return this.#fail(res, 'CREATE CONTAINER');
    await res.arrayBuffer();
  }

  /** Deletes the container of these settings; a missing one is not an error. */
  async deleteContainer(): Promise<void> {
    const res = await this.#request('DELETE', null, { query: { restype: 'container' } });
    if (!res.ok && res.status !== 404) return this.#fail(res, 'DELETE CONTAINER');
    await res.arrayBuffer().catch(() => undefined);
  }

  async put(key: string, body: Uint8Array, opts: PutOptions = {}): Promise<void> {
    const headers: Record<string, string> = {
      'content-type': opts.contentType ?? 'application/octet-stream',
      'x-ms-blob-type': 'BlockBlob',
    };
    if (opts.ifAbsent) headers['if-none-match'] = '*';
    const res = await this.#request('PUT', key, { body, headers });
    if (opts.ifAbsent && (res.status === 409 || res.status === 412)) {
      await res.arrayBuffer().catch(() => undefined);
      throw new ObjectExistsError(`${key} exists`);
    }
    if (!res.ok) return this.#fail(res, 'PUT');
    await res.arrayBuffer();
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.#request('GET', key);
    if (res.status === 404) {
      await res.arrayBuffer().catch(() => undefined);
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
    await res.arrayBuffer().catch(() => undefined);
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let marker: string | null = null;
    do {
      const query: Record<string, string> = { restype: 'container', comp: 'list', prefix };
      if (marker) query['marker'] = marker;
      const res = await this.#request('GET', null, { query });
      if (!res.ok) return this.#fail(res, 'LIST');
      const xml = await res.text();
      for (const m of xml.matchAll(/<Name>([^<]*)<\/Name>/g)) out.push(xmlText(m[1]!));
      const next = xmlText(/<NextMarker>([^<]*)<\/NextMarker>/.exec(xml)?.[1] ?? '');
      marker = next === '' ? null : next;
    } while (marker);
    return out.sort();
  }

  /** A read-only service SAS URL for one blob, valid until `expiresAt` (Unix ms). */
  signedUrl(key: string, expiresAt: number): string {
    const expiry = new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const canonical = `/blob/${this.#s.account}/${this.#s.container}/${key}`;
    // Service SAS string to sign for version 2021-08-06: sixteen fields, in this order.
    const toSign = [
      'r', // signedPermissions
      '', // signedStart
      expiry, // signedExpiry
      canonical, // canonicalizedResource
      '', // signedIdentifier
      '', // signedIP
      '', // signedProtocol
      API_VERSION, // signedVersion
      'b', // signedResource
      '', // signedSnapshotTime
      '', // signedEncryptionScope
      '', // rscc
      '', // rscd
      '', // rsce
      '', // rscl
      '', // rsct
    ].join('\n');
    const sig = hmacB64(this.#s.accountKey, toSign);
    const qs = new URLSearchParams({
      sv: API_VERSION,
      sr: 'b',
      sp: 'r',
      se: expiry,
      sig,
    }).toString();
    return `${this.#origin}${this.#wirePath(key)}?${qs}`;
  }
}
