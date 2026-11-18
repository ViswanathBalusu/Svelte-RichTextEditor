/**
 * The client of the administration console (UX-089). It calls the published administration API
 * and nothing else: every method below is one operation of spec/dep/dep-1.openapi.json, and the
 * test in test/ux-089-admin-console.test.ts runs it against a mock built from that file alone,
 * which answers `not_found` to any other route and records it.
 *
 * Conventions of 05 §6.1: JSON bodies, problem details for errors, `If-Match` on updates,
 * `Idempotency-Key` on creates, lists as `{ items, nextCursor }`. The credential is a service
 * credential, sent as `Authorization: Bearer`; it is kept in memory by the caller and is never
 * put in a URL.
 */

export interface QuotaSettings {
  connections: number | null;
  openDocuments: number | null;
  commitRate: number | null;
  roomCpuBudget: number | null;
  storage: number | null;
  exportConcurrency: number | null;
  exportMinutes: number | null;
}
export type QuotaName = keyof QuotaSettings;
export const QUOTA_NAMES: readonly QuotaName[] = [
  'connections',
  'openDocuments',
  'commitRate',
  'roomCpuBudget',
  'storage',
  'exportConcurrency',
  'exportMinutes',
];

export interface TenantKey {
  kid: string;
  use: 'user' | 'service';
  alg: 'ES256' | 'EdDSA' | 'RS256';
  thumbprint: string;
  issuer: string | null;
  jwk: Record<string, unknown>;
}
export interface KeyRegistration {
  kid: string;
  use: 'user' | 'service';
  alg: 'ES256' | 'EdDSA' | 'RS256';
  jwk: Record<string, unknown>;
  issuer?: string | null;
}

export interface RetentionPolicy {
  mode: 'keep_all' | 'thin_payloads';
  afterDays?: number;
}
export interface RetentionView {
  policy: RetentionPolicy | null;
  effective: RetentionPolicy;
  source: 'document' | 'tenant' | 'default';
}

export interface Hold {
  id: string;
  document: string;
  reason: string;
  placedBy: string;
  placedAt: string;
}

export interface WebhookView {
  id: string;
  url: string;
  events: string[];
  activeSecrets: number;
  createdAt: string;
  updatedAt: string;
  /** Present once, on creation and on rotation. */
  secret?: string;
}

export interface AuditItem {
  id: string;
  document: string | null;
  actor: string;
  kind: string;
  scopes: string[];
  at: string;
}
export interface AuditFilters {
  document?: string;
  actor?: string;
  kind?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface FontFace {
  style: string;
  weight: number;
  italic: boolean;
  url: string;
  sha256: string;
  bytes: number;
  format: string;
}
export interface FontFamily {
  family: string;
  role: string;
  licence: string;
  lineHeight: number | null;
  faces: FontFace[];
}
export interface FontManifest {
  version: string;
  defaultFamily: string | null;
  families: FontFamily[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface Etagged<T> {
  value: T;
  etag: string | null;
}

/** An answer that is not 2xx: the problem details of RFC 9457 (05 §6.1). */
export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
  }
}

export interface AdminClientOptions {
  /** The `rest` base URL of discovery (05 §2), for example `https://docs.example.com/v1`. */
  endpoint: string;
  /** A service credential. A user token never grants access (07 §12). */
  credential: string;
  fetch?: typeof fetch;
  /** Sent as `DEP-Actor`, so that the audit trail names the person at the console. */
  actor?: string;
}

interface Call {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  ifMatch?: string;
  idempotent?: boolean;
}
interface Answer {
  status: number;
  body: unknown;
  etag: string | null;
}

function problemOf(status: number, body: unknown): AdminApiError {
  if (typeof body === 'object' && body !== null) {
    const o = body as Record<string, unknown>;
    const code = typeof o['code'] === 'string' ? o['code'] : 'unknown';
    const detail =
      typeof o['detail'] === 'string'
        ? o['detail']
        : typeof o['title'] === 'string'
          ? o['title']
          : `The service answered ${status}.`;
    return new AdminApiError(status, code, detail);
  }
  return new AdminApiError(status, 'unknown', `The service answered ${status}.`);
}

export class AdminClient {
  readonly #base: string;
  readonly #credential: string;
  readonly #actor: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: AdminClientOptions) {
    this.#base = options.endpoint.replace(/\/+$/, '');
    this.#credential = options.credential;
    this.#actor = options.actor;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async #call(method: string, path: string, call: Call = {}): Promise<Answer> {
    const url = new URL(this.#base + path);
    for (const [k, v] of Object.entries(call.query ?? {}))
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#credential}`,
      Accept: 'application/json',
    };
    if (this.#actor !== undefined) headers['DEP-Actor'] = this.#actor;
    if (call.ifMatch !== undefined) headers['If-Match'] = call.ifMatch;
    if (call.idempotent === true) headers['Idempotency-Key'] = crypto.randomUUID();
    const init: RequestInit = { method, headers };
    if (call.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(call.body);
    }
    let res: Response;
    try {
      res = await this.#fetch(url.toString(), init);
    } catch {
      throw new AdminApiError(0, 'unavailable', 'The service could not be reached.');
    }
    const text = res.status === 204 ? '' : await res.text();
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!res.ok) throw problemOf(res.status, body);
    return { status: res.status, body, etag: res.headers.get('ETag') };
  }

  /**
   * Whether the credential may administer: the console reads the quotas, a service-only route.
   * Anything but a 2xx means no. A refusal (401, 403) is a normal answer, not an error.
   */
  async checkAccess(): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    try {
      await this.#call('GET', '/quotas');
      return { ok: true };
    } catch (e) {
      if (e instanceof AdminApiError) return { ok: false, code: e.code, message: e.message };
      throw e;
    }
  }

  // Quotas (UX-078).
  async getQuotas(): Promise<Etagged<QuotaSettings>> {
    const a = await this.#call('GET', '/quotas');
    return { value: a.body as QuotaSettings, etag: a.etag };
  }
  async setQuotas(values: Partial<QuotaSettings>, etag: string): Promise<Etagged<QuotaSettings>> {
    const a = await this.#call('PUT', '/quotas', { body: values, ifMatch: etag });
    return { value: a.body as QuotaSettings, etag: a.etag };
  }

  // Origins and keys (UX-077).
  async listOrigins(): Promise<string[]> {
    const a = await this.#call('GET', '/origins');
    return (a.body as { origins: string[] }).origins;
  }
  async addOrigin(origin: string): Promise<void> {
    await this.#call('POST', '/origins', { body: { origin }, idempotent: true });
  }
  async removeOrigin(origin: string): Promise<void> {
    await this.#call('DELETE', `/origins/${encodeURIComponent(origin)}`, { ifMatch: '*' });
  }
  async listKeys(): Promise<TenantKey[]> {
    const a = await this.#call('GET', '/keys');
    return (a.body as { keys: TenantKey[] }).keys;
  }
  async registerKey(key: KeyRegistration): Promise<TenantKey> {
    const a = await this.#call('POST', '/keys', { body: key, idempotent: true });
    return a.body as TenantKey;
  }
  async removeKey(kid: string): Promise<void> {
    await this.#call('DELETE', `/keys/${encodeURIComponent(kid)}`, { ifMatch: '*' });
  }

  // Retention and holds (UX-080).
  async getRetention(): Promise<Etagged<RetentionPolicy>> {
    const a = await this.#call('GET', '/retention');
    return { value: a.body as RetentionPolicy, etag: a.etag };
  }
  async setRetention(policy: RetentionPolicy, etag: string): Promise<Etagged<RetentionPolicy>> {
    const a = await this.#call('PUT', '/retention', { body: policy, ifMatch: etag });
    return { value: a.body as RetentionPolicy, etag: a.etag };
  }
  async getDocumentRetention(id: string): Promise<Etagged<RetentionView>> {
    const a = await this.#call('GET', `/documents/${encodeURIComponent(id)}/retention`);
    return { value: a.body as RetentionView, etag: a.etag };
  }
  async setDocumentRetention(
    id: string,
    policy: RetentionPolicy,
    etag: string,
  ): Promise<Etagged<RetentionView>> {
    const a = await this.#call('PUT', `/documents/${encodeURIComponent(id)}/retention`, {
      body: policy,
      ifMatch: etag,
    });
    return { value: a.body as RetentionView, etag: a.etag };
  }
  async listHolds(cursor?: string): Promise<Page<Hold>> {
    const a = await this.#call('GET', '/holds', { query: { cursor, limit: 50 } });
    return a.body as Page<Hold>;
  }
  async placeHold(document: string, reason: string): Promise<Hold> {
    const a = await this.#call('POST', `/documents/${encodeURIComponent(document)}/holds`, {
      body: { reason },
      idempotent: true,
    });
    return a.body as Hold;
  }

  // Webhooks (UX-079).
  async listWebhooks(cursor?: string): Promise<Page<WebhookView>> {
    const a = await this.#call('GET', '/webhooks', { query: { cursor, limit: 50 } });
    return a.body as Page<WebhookView>;
  }
  async createWebhook(url: string, events: string[]): Promise<WebhookView> {
    const a = await this.#call('POST', '/webhooks', { body: { url, events }, idempotent: true });
    return a.body as WebhookView;
  }
  /** Changes the address or the events, or rotates or retires a secret (PRO-070). */
  async updateWebhook(
    id: string,
    change: { url?: string; events?: string[]; rotate?: true; retire?: true },
  ): Promise<WebhookView> {
    const path = `/webhooks/${encodeURIComponent(id)}`;
    const current = await this.#call('GET', path);
    if (current.etag === null)
      throw new AdminApiError(0, 'unavailable', 'The service sent no ETag for the subscription.');
    const a = await this.#call('PATCH', path, { body: change, ifMatch: current.etag });
    return a.body as WebhookView;
  }
  async deleteWebhook(id: string): Promise<void> {
    await this.#call('DELETE', `/webhooks/${encodeURIComponent(id)}`, { ifMatch: '*' });
  }
  async pingWebhook(id: string): Promise<string> {
    const a = await this.#call('POST', `/webhooks/${encodeURIComponent(id)}/ping`);
    return (a.body as { deliveryId: string }).deliveryId;
  }
  async replayWebhookDelivery(id: string, deliveryId: string): Promise<string> {
    const a = await this.#call(
      'POST',
      `/webhooks/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/replay`,
    );
    return (a.body as { deliveryId: string }).deliveryId;
  }

  // Audit (UX-081) and fonts (UX-079).
  async queryAudit(filters: AuditFilters = {}): Promise<Page<AuditItem>> {
    const a = await this.#call('GET', '/audit', { query: { ...filters } });
    return a.body as Page<AuditItem>;
  }
  async getFonts(): Promise<FontManifest> {
    const a = await this.#call('GET', '/fonts');
    return a.body as FontManifest;
  }
}

/** Reads a quota field: empty means "no value" (null); otherwise a whole number of 0 or more. */
export function parseQuota(text: string): { ok: true; value: number | null } | { ok: false } {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  if (!/^\d{1,15}$/.test(t)) return { ok: false };
  return { ok: true, value: Number(t) };
}
