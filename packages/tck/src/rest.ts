/**
 * The kit's side of the control plane (05 §6): plain HTTP requests with a bearer credential, and
 * the bootstrap calls a host makes with its service credential (05 §11: tokens through
 * `POST /tokens`, documents created by the kit). Responses are returned as they are; the scenarios
 * decide what is right.
 */
import type {
  CdmEnvelope,
  CreateDocumentRequest,
  DocRole,
  DocumentResource,
  Grants,
  RegionGrant,
  TokenRequest,
  TokenResponse,
} from '@docedit/protocol';
import { KitFailure, isObject, show } from './assert.ts';

export interface HttpResponse {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** The parsed body, or undefined when it is empty or not JSON. */
  readonly json: unknown;
}

export interface RequestOptions {
  /** A bearer credential: a user token or the service credential. */
  token?: string;
  /** A JSON body. */
  body?: unknown;
  /** A body sent as it is (malformed JSON on purpose). */
  rawBody?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
}

export type Observer = (res: HttpResponse) => void;

export class Http {
  private readonly observers = new Set<Observer>();

  /** Sees every response, for the coverage and leak oracles. */
  observe(fn: Observer): () => void {
    this.observers.add(fn);
    return () => this.observers.delete(fn);
  }

  async request(method: string, url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined) u.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
    if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
    let body: string | undefined;
    if (opts.rawBody !== undefined) body = opts.rawBody;
    else if (opts.body !== undefined) body = JSON.stringify(opts.body);
    if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type'))
      headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(u, { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch {
      // A pooled keep-alive connection the server closed while it was idle fails the request
      // before it is sent; one retry on a fresh connection tells that apart from a server that
      // is down.
      res = await fetch(u, { method, headers, ...(body !== undefined ? { body } : {}) });
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      json = undefined;
    }
    const out: HttpResponse = {
      method,
      url: u.toString(),
      status: res.status,
      headers: res.headers,
      text,
      json,
    };
    for (const o of this.observers) o(out);
    return out;
  }
}

/** A response that must have succeeded; otherwise a failure naming the call. */
export function expectStatus(
  res: HttpResponse,
  status: number | readonly number[],
  what: string,
): HttpResponse {
  const ok = typeof status === 'number' ? res.status === status : status.includes(res.status);
  if (!ok)
    throw new KitFailure(
      `${what}: ${res.method} ${new URL(res.url).pathname} answered ${res.status}`,
      `HTTP ${typeof status === 'number' ? status : status.join(' or ')}`,
      `HTTP ${res.status} ${show(res.json ?? res.text)}`,
    );
  return res;
}

/** The `code` member of a problem document, or undefined. */
export function problemCode(res: HttpResponse): string | undefined {
  return isObject(res.json) && typeof res.json['code'] === 'string' ? res.json['code'] : undefined;
}

/** A region grant as a host sets it (07 §1). */
export interface GrantSpec {
  region: string;
  principal: string;
  role: 'viewer' | 'commenter' | 'suggester' | 'editor';
  expiresAt?: string;
}

/**
 * The calls a host backend makes with its service credential (05 §3.2, §6.2): the whole of what
 * the kit needs from a server besides the public DEP interfaces (05 §11 bootstrap contract).
 */
export class ServiceClient {
  readonly http: Http;
  readonly rest: string;
  private readonly credential: string;

  constructor(http: Http, rest: string, credential: string) {
    this.http = http;
    this.rest = rest.replace(/\/$/, '');
    this.credential = credential;
  }

  url(path: string): string {
    return `${this.rest}${path}`;
  }

  /** A request with the service credential. */
  call(
    method: string,
    path: string,
    opts: Omit<RequestOptions, 'token'> = {},
  ): Promise<HttpResponse> {
    return this.http.request(method, this.url(path), { ...opts, token: this.credential });
  }

  /** A request with another credential (a user token, or none). */
  as(
    token: string | undefined,
    method: string,
    path: string,
    opts: Omit<RequestOptions, 'token'> = {},
  ) {
    return this.http.request(
      method,
      this.url(path),
      token === undefined ? opts : { ...opts, token },
    );
  }

  /** `POST /tokens` (05 §3.1; D60). */
  async mint(req: TokenRequest): Promise<TokenResponse> {
    const res = expectStatus(
      await this.call('POST', '/tokens', { body: req }),
      [200, 201],
      'minting a token',
    );
    if (!isObject(res.json) || typeof res.json['token'] !== 'string')
      throw new KitFailure(
        'POST /tokens: no token in the response',
        '{ token, expiresAt }',
        res.json,
      );
    return res.json as unknown as TokenResponse;
  }

  /** A user token for `sub` with these roles (05 §3.1). */
  async token(
    sub: string,
    docs: Readonly<Record<string, DocRole>>,
    extra: Partial<Omit<TokenRequest, 'sub' | 'docs'>> = {},
  ): Promise<string> {
    return (await this.mint({ sub, docs: { ...docs }, ...extra })).token;
  }

  /** `POST /documents` (05 §6.2; D62). */
  async createDocument(req: CreateDocumentRequest): Promise<DocumentResource> {
    const res = expectStatus(
      await this.call('POST', '/documents', { body: req }),
      [200, 201],
      'creating a document',
    );
    if (!isObject(res.json) || typeof res.json['id'] !== 'string')
      throw new KitFailure(
        'POST /documents: no id in the response',
        'a document resource',
        res.json,
      );
    return res.json as unknown as DocumentResource;
  }

  /** A document with CDM content and, when the server announces `regions`, initial grants. */
  async document(content: CdmEnvelope, grants: readonly GrantSpec[] = []): Promise<string> {
    const doc = await this.createDocument({ content });
    if (grants.length) await this.setGrants(doc.id, grants);
    return doc.id;
  }

  /** `GET` then `PATCH /documents/{id}/grants` with `If-Match` (D63): replaces the grants. */
  async setGrants(doc: string, grants: readonly GrantSpec[]): Promise<Grants> {
    const current = expectStatus(
      await this.call('GET', `/documents/${doc}/grants`),
      200,
      'reading grants',
    );
    const etag = current.headers.get('etag') ?? '*';
    const res = expectStatus(
      await this.call('PATCH', `/documents/${doc}/grants`, {
        body: { grants: grants as RegionGrant[] },
        headers: { 'if-match': etag },
      }),
      200,
      'changing grants',
    );
    return res.json as Grants;
  }

  /** `PATCH /documents/{id}` with a new `state` (D62). */
  async setState(doc: string, state: 'active' | 'locked' | 'archived'): Promise<void> {
    const current = expectStatus(
      await this.call('GET', `/documents/${doc}`),
      200,
      'reading a document',
    );
    const etag = current.headers.get('etag') ?? '*';
    expectStatus(
      await this.call('PATCH', `/documents/${doc}`, {
        body: { state },
        headers: { 'if-match': etag },
      }),
      200,
      'changing the document state',
    );
  }

  /** `PUT /documents/{id}/content`: a snapshot commit with origin `import` (05 §6.2). */
  async replaceContent(doc: string, content: CdmEnvelope): Promise<HttpResponse> {
    const current = await this.call('GET', `/documents/${doc}/content`);
    const etag = current.headers.get('etag') ?? '*';
    return expectStatus(
      await this.call('PUT', `/documents/${doc}/content`, {
        body: content,
        headers: { 'if-match': etag },
      }),
      [200, 201, 204],
      'replacing the content',
    );
  }

  /** `POST /sessions/revoke` (05 §3.3; D73). */
  async revoke(sub: string, doc?: string): Promise<void> {
    expectStatus(
      await this.call('POST', '/sessions/revoke', {
        body: doc === undefined ? { sub } : { sub, doc },
      }),
      [200, 204],
      'revoking sessions',
    );
  }
}
