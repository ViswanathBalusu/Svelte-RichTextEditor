/**
 * The host's calls to the document service's control plane (05 §6) with its service credential
 * (05 §3.2; PRO-012). Only the host's server makes these calls; the page and the editor never see
 * the credential. A call made for a person names them with `DEP-Actor` (13 §11.3), so that the
 * service's history and audit name the person rather than the host.
 */
import type {
  CreateDocumentRequest,
  DocumentResource,
  ExportJob,
  FieldInfo,
  Grants,
  ProblemDetails,
  RegionGrant,
  RegionInfo,
  Template,
  TemplateCreate,
  TokenRequest,
  TokenResponse,
} from '@docedit/protocol';

/** A refusal or failure of the service, with its problem details (05 §6.1). */
export class ServiceError extends Error {
  override name = 'ServiceError';
  readonly status: number;
  /** The registry code (05 §5.8), or `unavailable` when the service could not be reached. */
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ServiceClientOptions {
  /** The REST base (`rest` of the discovery document). */
  rest: string;
  /** The service credential. */
  apiKey: string;
  fetch?: typeof fetch;
}

/** What `/webhooks` returns about a subscription (never its secret, except once at creation). */
export interface WebhookSubscription {
  id: string;
  url: string;
  events: string[];
  activeSecrets: number;
}

/** 05 §6.1: list resources return at most 200 items per page. */
export const MAX_PAGE = 200;

export class ServiceClient {
  readonly #rest: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(opts: ServiceClientOptions) {
    this.#rest = opts.rest.replace(/\/+$/, '');
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetch ?? fetch;
  }

  async #call<T>(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; actor?: string } = {},
  ): Promise<{ status: number; body: T; etag: string | null }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: 'application/json',
      ...opts.headers,
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.actor !== undefined) headers['DEP-Actor'] = opts.actor;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#rest}${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch (e) {
      throw new ServiceError(
        0,
        'unavailable',
        `the document service is unreachable (${e instanceof Error ? e.name : 'error'})`,
      );
    }
    const text = await res.text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const p = (body ?? {}) as Partial<ProblemDetails>;
      // The problem's detail names rules and identifiers only, never content (BE-088).
      throw new ServiceError(
        res.status,
        p.code ?? 'internal',
        `${method} ${path.split('?')[0]}: ${res.status} ${p.code ?? ''} ${p.detail ?? ''}`.trim(),
      );
    }
    return { status: res.status, body: body as T, etag: res.headers.get('etag') };
  }

  /** `POST /tokens` (05 §3.1 service-minted; PRO-011). */
  async mintToken(request: TokenRequest): Promise<TokenResponse> {
    return (await this.#call<TokenResponse>('POST', '/tokens', { body: request })).body;
  }

  /** `POST /sessions/revoke` (05 §3.3): the user's tokens issued before now stop working. */
  async revoke(sub: string, doc?: string): Promise<void> {
    await this.#call('POST', '/sessions/revoke', { body: doc ? { sub, doc } : { sub } });
  }

  /** `POST /documents` with an idempotency key, so that a retried creation creates one document. */
  async createDocument(
    request: CreateDocumentRequest,
    idempotencyKey: string,
    actor?: string,
  ): Promise<DocumentResource> {
    return (
      await this.#call<DocumentResource>('POST', '/documents', {
        body: request,
        headers: { 'Idempotency-Key': idempotencyKey },
        ...(actor !== undefined ? { actor } : {}),
      })
    ).body;
  }

  /** `GET /documents`: one page, optionally filtered by `externalId` (05 §6.2; UX-094). */
  async listDocuments(
    query: { externalId?: string; cursor?: string; limit?: number } = {},
  ): Promise<Page<DocumentResource>> {
    const q = new URLSearchParams();
    if (query.externalId !== undefined) q.set('externalId', query.externalId);
    if (query.cursor !== undefined) q.set('cursor', query.cursor);
    q.set('limit', String(Math.min(query.limit ?? MAX_PAGE, MAX_PAGE)));
    return (await this.#call<Page<DocumentResource>>('GET', `/documents?${q}`)).body;
  }

  /** The document the host created with `externalId`, or null. */
  async findByExternalId(externalId: string): Promise<DocumentResource | null> {
    const page = await this.listDocuments({ externalId, limit: MAX_PAGE });
    return page.items.find((d) => d.externalId === externalId) ?? null;
  }

  async getDocument(id: string): Promise<{ doc: DocumentResource; etag: string }> {
    const r = await this.#call<DocumentResource>('GET', `/documents/${encodeURIComponent(id)}`);
    return { doc: r.body, etag: r.etag ?? '' };
  }

  /** `PATCH /documents/{id}` with `If-Match` (05 §6.1). */
  async updateDocument(
    id: string,
    patch: { title?: string | null },
    etag: string,
    actor?: string,
  ): Promise<DocumentResource> {
    return (
      await this.#call<DocumentResource>('PATCH', `/documents/${encodeURIComponent(id)}`, {
        body: patch,
        headers: { 'If-Match': etag },
        ...(actor !== undefined ? { actor } : {}),
      })
    ).body;
  }

  /** `DELETE /documents/{id}`: a soft delete; the purge follows the retention policy (05 §6.2). */
  async deleteDocument(id: string, actor?: string): Promise<void> {
    await this.#call('DELETE', `/documents/${encodeURIComponent(id)}`, {
      ...(actor !== undefined ? { actor } : {}),
    });
  }

  async getGrants(id: string): Promise<{ grants: Grants; etag: string }> {
    const r = await this.#call<Grants>('GET', `/documents/${encodeURIComponent(id)}/grants`);
    return { grants: r.body, etag: r.etag ?? '' };
  }

  /** `PATCH /documents/{id}/grants`: the list replaces the grants (05 §6.2; 07 §9). */
  async replaceGrants(
    id: string,
    grants: readonly RegionGrant[],
    etag: string,
    actor?: string,
  ): Promise<Grants> {
    return (
      await this.#call<Grants>('PATCH', `/documents/${encodeURIComponent(id)}/grants`, {
        body: { grants },
        headers: { 'If-Match': etag },
        ...(actor !== undefined ? { actor } : {}),
      })
    ).body;
  }

  async listRegions(id: string): Promise<RegionInfo[]> {
    return (
      await this.#call<Page<RegionInfo>>(
        'GET',
        `/documents/${encodeURIComponent(id)}/regions?limit=${MAX_PAGE}`,
      )
    ).body.items;
  }

  /** `POST /templates`: marks a document as a template (12 §9; FRW-062; service credential only). */
  async createTemplate(request: TemplateCreate, actor?: string): Promise<Template> {
    return (
      await this.#call<Template>('POST', '/templates', {
        body: request,
        ...(actor !== undefined ? { actor } : {}),
      })
    ).body;
  }

  /** `GET /webhooks`: the tenant's subscriptions, without secrets (05 §6.2; service credential). */
  async listWebhooks(): Promise<WebhookSubscription[]> {
    return (await this.#call<Page<WebhookSubscription>>('GET', '/webhooks')).body.items;
  }

  /** `POST /webhooks`: the subscription and its secret, which the service shows only here. */
  async createWebhook(request: {
    url: string;
    events: readonly string[];
  }): Promise<WebhookSubscription & { secret: string }> {
    return (
      await this.#call<WebhookSubscription & { secret: string }>('POST', '/webhooks', {
        body: request,
      })
    ).body;
  }

  /** `DELETE /webhooks/{id}` (the registrar removes what it replaces, so `If-Match: *`). */
  async deleteWebhook(id: string): Promise<void> {
    await this.#call('DELETE', `/webhooks/${encodeURIComponent(id)}`, {
      headers: { 'If-Match': '*' },
    });
  }

  /** `GET /templates`: the tenant's templates, oldest first (FRW-062). */
  async listTemplates(): Promise<Template[]> {
    return (await this.#call<Page<Template>>('GET', '/templates')).body.items;
  }

  /** `GET /documents/{id}/fields`: the fields of a document with their kinds (12 §10; FRW-060). */
  async listFields(id: string): Promise<FieldInfo[]> {
    const items: FieldInfo[] = [];
    let cursor: string | null = null;
    do {
      const q = new URLSearchParams({ limit: String(MAX_PAGE) });
      if (cursor !== null) q.set('cursor', cursor);
      const page: Page<FieldInfo> = (
        await this.#call<Page<FieldInfo>>('GET', `/documents/${encodeURIComponent(id)}/fields?${q}`)
      ).body;
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return items;
  }

  async getExport(jobId: string): Promise<ExportJob> {
    return (await this.#call<ExportJob>('GET', `/exports/${encodeURIComponent(jobId)}`)).body;
  }

  /** `GET /documents/{id}/workflow` (12 §6.1; FRW-025): the resource, or null when there is none. */
  async getWorkflow(id: string): Promise<{ workflow: WorkflowView; etag: string } | null> {
    try {
      const r = await this.#call<WorkflowView>(
        'GET',
        `/documents/${encodeURIComponent(id)}/workflow`,
      );
      return { workflow: r.body, etag: r.etag ?? '' };
    } catch (e) {
      if (e instanceof ServiceError && e.status === 404) return null;
      throw e;
    }
  }

  /** `PUT /documents/{id}/workflow` with `If-Match`: `"0"` creates it (12 §6.1; FRW-025). */
  async putWorkflow(
    id: string,
    body: WorkflowView,
    ifMatch: string,
    actor?: string,
  ): Promise<WorkflowView> {
    return (
      await this.#call<WorkflowView>('PUT', `/documents/${encodeURIComponent(id)}/workflow`, {
        body,
        headers: { 'If-Match': ifMatch },
        ...(actor !== undefined ? { actor } : {}),
      })
    ).body;
  }

  /** `POST /documents/{id}/workflow/send` (12 §6.2; FRW-027): activates the first participants. */
  async sendWorkflow(id: string, idempotencyKey: string, actor?: string): Promise<WorkflowView> {
    return (
      await this.#call<WorkflowView>('POST', `/documents/${encodeURIComponent(id)}/workflow/send`, {
        headers: { 'Idempotency-Key': idempotencyKey },
        ...(actor !== undefined ? { actor } : {}),
      })
    ).body;
  }

  /** `GET /documents/{id}/workflow/final`: the sealed PDF, once the workflow is finalised (12 §8.2). */
  async getSealedPdf(id: string): Promise<Uint8Array> {
    return this.#bytes(`/documents/${encodeURIComponent(id)}/workflow/final`);
  }

  /** `GET /documents/{id}/workflow/evidence`: the evidence bundle, as the service serialises it. */
  async getEvidenceBundle(id: string): Promise<Uint8Array> {
    return this.#bytes(`/documents/${encodeURIComponent(id)}/workflow/evidence`);
  }

  async #bytes(path: string): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#rest}${path}`, {
        headers: { Authorization: `Bearer ${this.#apiKey}` },
      });
    } catch (e) {
      throw new ServiceError(
        0,
        'unavailable',
        `the document service is unreachable (${e instanceof Error ? e.name : 'error'})`,
      );
    }
    const data = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) {
      let code = 'internal';
      try {
        code = (JSON.parse(new TextDecoder().decode(data)) as Partial<ProblemDetails>).code ?? code;
      } catch {
        // Not a problem document: the status stands.
      }
      throw new ServiceError(res.status, code, `GET ${path}: ${res.status} ${code}`);
    }
    return data;
  }
}

/** The workflow resource as the host reads and writes it (12 §6.1); the service checks the shape. */
export interface WorkflowView {
  id: string;
  doc: string;
  state: string;
  rev: number;
  timeZone: string;
  participants: Array<{
    id: string;
    roles: string[];
    kind: string;
    order: number;
    sub?: string;
    name?: string;
    state?: string;
    [member: string]: unknown;
  }>;
  [member: string]: unknown;
}
