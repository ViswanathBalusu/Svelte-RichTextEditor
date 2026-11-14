/**
 * The assets, exports and fonts routes for backend-dep's tests (PRO-096). The mock service offers
 * none of them, so this wrapper answers them, records what arrived and passes every other request
 * to the DEP server. The pre-signed storage address is answered here too, so that the tests can
 * see that no bearer token reaches it (05 §3.1). Universal, like the rest of the support code.
 */
import type { HttpRequest, HttpResponse, MemoryServer, ServerSocket } from './memory-network.ts';
import type { MockDepServer } from './mock-server.ts';

/** The host of the pre-signed uploads. */
export const STORAGE = 'https://storage.test';

/** A MIME type that the asset worker refuses (asset.failed). */
export const REFUSED_MIME = 'application/x-refused';
/** A MIME type for which the worker never answers (for a test of close() during an upload). */
export const SILENT_MIME = 'application/x-silent';

interface Asset {
  id: string;
  mime: string;
  bytes: string | undefined;
}

interface Job {
  id: string;
  doc: string;
  target: string;
  seq: number;
  state: string;
  createdAt: string;
  updatedAt: string;
}

/** One request this wrapper answered, as the tests check it. */
export interface Answered {
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
}

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const problem = (status: number, code: string, detail: string): HttpResponse => ({
  status,
  headers: { 'content-type': 'application/problem+json' },
  body: JSON.stringify({ type: 'about:blank', title: code, status, code, detail }),
});

/** A UUID version 7 layout, numbered, so that the shapes of the definition accept it. */
const uuid7 = (n: number): string => `01928000-0000-7000-8000-${String(n).padStart(12, '0')}`;

export class FileServer implements MemoryServer {
  readonly assets = new Map<string, Asset>();
  readonly jobs = new Map<string, Job>();
  /** The requests this wrapper answered (not those the DEP server answered). */
  readonly answered: Answered[] = [];
  /** The bodies that arrived at pre-signed addresses, with whether a bearer token came along. */
  readonly stored: Array<{ url: string; body: string | undefined; bearer: boolean }> = [];
  private readonly dep: MockDepServer;
  private n = 0;

  constructor(dep: MockDepServer) {
    this.dep = dep;
  }

  accept(socket: ServerSocket): string | null {
    return this.dep.accept(socket);
  }

  async http(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    if (url.origin === STORAGE) return this.storage(req, url);
    const path = url.pathname;
    const route = this.routeOf(req.method, path);
    if (route === null) return this.dep.http(req);
    this.answered.push({ method: req.method, path, headers: req.headers });
    const auth = req.headers['authorization'] ?? '';
    const token = auth.startsWith('Bearer ') ? this.dep.token(auth.slice(7)) : undefined;
    if (!token) return problem(401, 'unauthenticated', 'no valid bearer token');
    return route.handle(token.docs, req);
  }

  private routeOf(
    method: string,
    path: string,
  ): {
    handle(
      docs: Readonly<Record<string, string>>,
      req: HttpRequest,
    ): HttpResponse | Promise<HttpResponse>;
  } | null {
    const p = path.split('/');
    // p: ['', 'v1', ...]
    if (p[1] !== 'v1') return null;
    if (p[2] === 'documents' && p[4] === 'assets' && p.length === 5 && method === 'POST')
      return { handle: (docs, req) => this.createAsset(p[3]!, docs, req) };
    if (p[2] === 'documents' && p[4] === 'assets' && p[5] === 'resolve' && method === 'POST')
      return { handle: (docs, req) => this.resolve(p[3]!, docs, req) };
    if (p[2] === 'assets' && p[4] === 'complete' && method === 'POST')
      return { handle: () => this.complete(p[3]!) };
    if (p[2] === 'documents' && p[4] === 'exports' && method === 'POST')
      return { handle: (docs, req) => this.requestExport(p[3]!, docs, req) };
    if (p[2] === 'exports' && p[3] !== undefined && method === 'GET')
      return { handle: (docs) => this.getExport(p[3]!, docs) };
    if (p[2] === 'exports' && p[3] !== undefined && method === 'DELETE')
      return { handle: (docs) => this.cancelExport(p[3]!, docs) };
    if (p[2] === 'fonts' && method === 'GET')
      return { handle: () => json(200, { version: '1', families: [] }) };
    return null;
  }

  private createAsset(
    doc: string,
    docs: Readonly<Record<string, string>>,
    req: HttpRequest,
  ): HttpResponse {
    if (!docs[doc]) return problem(403, 'forbidden', 'the token does not cover this document');
    const body = JSON.parse(req.body ?? '{}') as { mime: string };
    const id = uuid7(++this.n);
    this.assets.set(id, { id, mime: body.mime, bytes: undefined });
    return json(201, { asset: id, upload: { url: `${STORAGE}/up/${id}` } });
  }

  private resolve(
    doc: string,
    docs: Readonly<Record<string, string>>,
    req: HttpRequest,
  ): HttpResponse {
    if (!docs[doc]) return problem(403, 'forbidden', 'the token does not cover this document');
    const body = JSON.parse(req.body ?? '{}') as { assets: string[] };
    // The shape of ResolvedAssets (05 §6.2): each asset with its signed URL, its expiry and its type.
    return json(200, {
      assets: body.assets.map((a) => ({
        asset: a,
        url: `${STORAGE}/get/${a}`,
        expiresAt: '2026-11-13T12:00:00.000Z',
        contentType: this.assets.get(a)?.mime ?? 'application/octet-stream',
      })),
    });
  }

  private complete(assetId: string): HttpResponse {
    const a = this.assets.get(assetId);
    if (!a) return problem(404, 'not_found', `no asset ${assetId}`);
    const type = a.mime === REFUSED_MIME ? 'asset.failed' : 'asset.ready';
    if (a.mime !== SILENT_MIME) this.dep.sessions.at(-1)?.event(type, `/assets/${assetId}`);
    return { status: 202, headers: {} };
  }

  private requestExport(
    doc: string,
    docs: Readonly<Record<string, string>>,
    req: HttpRequest,
  ): HttpResponse {
    if (!docs[doc]) return problem(403, 'forbidden', 'the token does not cover this document');
    const body = JSON.parse(req.body ?? '{}') as { target: string };
    const job: Job = {
      id: uuid7(++this.n),
      doc,
      target: body.target,
      seq: this.dep.service.document(doc)?.content().seq ?? 0,
      state: 'queued',
      createdAt: '2026-11-13T09:00:00.000Z',
      updatedAt: '2026-11-13T09:00:00.000Z',
    };
    this.jobs.set(job.id, job);
    return json(202, this.view(job));
  }

  private getExport(id: string, docs: Readonly<Record<string, string>>): HttpResponse {
    const job = this.jobs.get(id);
    if (!job || !docs[job.doc]) return problem(404, 'not_found', `no export ${id}`);
    return json(200, this.view(job), { etag: `"${job.id}:${job.state}"` });
  }

  private cancelExport(id: string, docs: Readonly<Record<string, string>>): HttpResponse {
    const job = this.jobs.get(id);
    if (!job || !docs[job.doc]) return problem(404, 'not_found', `no export ${id}`);
    job.state = 'cancelled';
    return { status: 204, headers: {} };
  }

  /** The job as the definition's ExportJob shape reads it. */
  private view(job: Job): Record<string, unknown> {
    return {
      id: job.id,
      doc: job.doc,
      target: job.target,
      seq: job.seq,
      state: job.state,
      progress: null,
      result: null,
      diagnostics: [],
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private storage(req: HttpRequest, url: URL): HttpResponse {
    const id = url.pathname.slice('/up/'.length);
    const a = this.assets.get(id);
    this.stored.push({
      url: req.url,
      body: req.body,
      bearer: 'authorization' in req.headers,
    });
    if (!a || req.method !== 'PUT') return problem(404, 'not_found', 'no such upload');
    a.bytes = req.body;
    return { status: 200, headers: {} };
  }
}
