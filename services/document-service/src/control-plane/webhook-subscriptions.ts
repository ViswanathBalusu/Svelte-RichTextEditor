/**
 * Webhook subscriptions (05 §6.2, §7; PRO-068): the operations of `/webhooks` and `/webhooks/{id}`
 * for a service credential, the subscription store they use, and the secret rotation of PRO-070
 * (two secrets are active until the old one is retired).
 *
 * Open (spec/dep gap G76): the published body of a subscription is a placeholder. The body read
 * here is the proposal in docs/adr/0151-control-plane-2-backlog-batch.md, not a published contract.
 *
 * Not built here, and kept out on purpose:
 * - the test ping and the replay of recent deliveries (PRO-068 criteria 4 and 5): they send
 *   requests, so they wait for the dispatcher (BE-055) and the egress proxy (BE-056, PRO-071);
 * - the wiring into the handler map and the router: that is in `handlers.ts` and the composition,
 *   which this lane does not own. The class below is what those files call.
 */
import { uuid7 } from '@docedit/model';
import type { Caller } from './pipeline.ts';
import { ApiError } from './problems.ts';
import { generateSecret } from './webhook-signing.ts';

/** The `If-Match` tags of a request: `*`, the strong tags listed, or null when absent (http.ts). */
export type IfMatch = '*' | readonly string[] | null;

/** An event name with its version suffix, for example `dep.document.state_changed.v1` (05 §7). */
export const EVENT_NAME = /^dep(\.[a-z_]+)+\.v[1-9][0-9]*$/;
export const MAX_EVENTS = 64;
export const MAX_URL_LENGTH = 2048;

export interface SubscriptionRecord {
  id: string;
  tenant: string;
  url: string;
  events: readonly string[];
  /** The active secrets: one while stable; two during a rotation, the older first. */
  secrets: readonly string[];
  /** Bumped on every change; the ETag is this number in quotes. */
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** The store the operations use. A compare-and-set on `version` keeps `If-Match` honest. */
export interface SubscriptionStore {
  insert(record: SubscriptionRecord): Promise<void>;
  get(tenant: string, id: string): Promise<SubscriptionRecord | null>;
  list(tenant: string): Promise<SubscriptionRecord[]>;
  /** Stores `next` when the stored version is `expectedVersion`; false otherwise. */
  replace(next: SubscriptionRecord, expectedVersion: number): Promise<boolean>;
  remove(tenant: string, id: string): Promise<boolean>;
}

/** An in-process store, for tests and for a deployment without PostgreSQL. */
export class MemorySubscriptionStore implements SubscriptionStore {
  readonly #rows = new Map<string, SubscriptionRecord>();

  #key(tenant: string, id: string): string {
    return `${tenant}\u0000${id}`;
  }

  insert(record: SubscriptionRecord): Promise<void> {
    this.#rows.set(this.#key(record.tenant, record.id), structuredClone(record));
    return Promise.resolve();
  }

  get(tenant: string, id: string): Promise<SubscriptionRecord | null> {
    const row = this.#rows.get(this.#key(tenant, id));
    return Promise.resolve(row ? structuredClone(row) : null);
  }

  list(tenant: string): Promise<SubscriptionRecord[]> {
    const out: SubscriptionRecord[] = [];
    for (const row of this.#rows.values())
      if (row.tenant === tenant) out.push(structuredClone(row));
    out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return Promise.resolve(out);
  }

  replace(next: SubscriptionRecord, expectedVersion: number): Promise<boolean> {
    const key = this.#key(next.tenant, next.id);
    const current = this.#rows.get(key);
    if (!current || current.version !== expectedVersion) return Promise.resolve(false);
    this.#rows.set(key, structuredClone(next));
    return Promise.resolve(true);
  }

  remove(tenant: string, id: string): Promise<boolean> {
    return Promise.resolve(this.#rows.delete(this.#key(tenant, id)));
  }
}

/** What a client reads about a subscription. Secrets are never listed; see `create` and `update`. */
export interface SubscriptionView {
  id: string;
  url: string;
  events: string[];
  /** How many secrets are active: 1, or 2 during a rotation (PRO-070). */
  activeSecrets: number;
  createdAt: string;
  updatedAt: string;
}

export interface Answer {
  status: number;
  body?: unknown;
  etag?: string;
  location?: string;
}

export interface WebhookSubscriptionsDeps {
  store: SubscriptionStore;
  now: () => number;
  /** A new identifier (UUID version 7, 01 §8). Defaults to `uuid7`. */
  newId?: () => string;
  /** A new secret of the form `whsec_…`. Defaults to `generateSecret`. */
  newSecret?: () => string;
}

const CREATE_KEYS = new Set(['url', 'events']);
const UPDATE_KEYS = new Set(['url', 'events', 'rotate', 'retire']);

/** The ETag of a version: a strong tag (RFC 9110 §8.8.3). */
export function etagOf(version: number): string {
  return `"${version}"`;
}

function view(record: SubscriptionRecord): SubscriptionView {
  return {
    id: record.id,
    url: record.url,
    events: [...record.events],
    activeSecrets: record.secrets.length,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

/** 07 §12: the operations of `/webhooks` are for a service credential; a user token is refused. */
export function requireServiceCredential(caller: Caller): void {
  if (caller.kind !== 'service')
    throw new ApiError('forbidden', 'webhook subscriptions need a service credential (07 §12)');
}

/**
 * The precondition of an update (05 §6.1; D61): 428 when If-Match is missing, 412 when it does not
 * name the current ETag. `*` matches anything.
 */
export function requireIfMatch(tags: IfMatch, current: string): void {
  if (tags === null)
    throw new ApiError('precondition_failed', 'the update needs If-Match with the current ETag', {
      status: 428,
    });
  if (tags === '*' || tags.includes(current)) return;
  throw new ApiError('precondition_failed', 'the resource changed since the ETag was read');
}

function bodyOf(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new ApiError('validation_failed', 'the body is a JSON object', {
      violations: [{ path: '/', rule: 'an object' }],
    });
  return body as Record<string, unknown>;
}

function refuseUnknown(obj: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const violations = Object.keys(obj)
    .filter((k) => !allowed.has(k))
    .map((k) => ({ path: `/${k}`, rule: `not a member of the subscription body` }));
  if (violations.length > 0)
    throw new ApiError('validation_failed', 'the body has members that are not defined', {
      violations,
    });
}

/** An absolute `http` or `https` URL. Reachability is decided at delivery (PRO-071), not here. */
function parseUrl(value: unknown): string {
  const bad = (rule: string): never => {
    throw new ApiError('validation_failed', 'the url is not usable', {
      violations: [{ path: '/url', rule }],
    });
  };
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH)
    return bad(`an absolute http or https URL of at most ${MAX_URL_LENGTH} characters`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return bad('an absolute http or https URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return bad('an http or https URL');
  return url.toString();
}

function parseEvents(value: unknown): string[] {
  const bad = (rule: string): never => {
    throw new ApiError('validation_failed', 'the events are not usable', {
      violations: [{ path: '/events', rule }],
    });
  };
  if (!Array.isArray(value)) return bad('an array of event names');
  if (value.length === 0) return bad('at least one event name');
  if (value.length > MAX_EVENTS) return bad(`at most ${MAX_EVENTS} event names`);
  const seen = new Set<string>();
  for (const name of value) {
    if (typeof name !== 'string' || !EVENT_NAME.test(name))
      return bad('event names with a version suffix, for example dep.document.changed.v1');
    if (seen.has(name)) return bad('no event name twice');
    seen.add(name);
  }
  return [...(value as string[])];
}

/** The operations of `/webhooks` and `/webhooks/{id}` (05 §6.2), over a store. */
export class WebhookSubscriptions {
  readonly #store: SubscriptionStore;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #newSecret: () => string;

  constructor(deps: WebhookSubscriptionsDeps) {
    this.#store = deps.store;
    this.#now = deps.now;
    this.#newId = deps.newId ?? uuid7;
    this.#newSecret = deps.newSecret ?? generateSecret;
  }

  /** `POST /webhooks`: 201 with the subscription and its one secret, which is shown only here. */
  async create(caller: Caller, body: unknown): Promise<Answer> {
    requireServiceCredential(caller);
    const obj = bodyOf(body);
    refuseUnknown(obj, CREATE_KEYS);
    const url = parseUrl(obj['url']);
    const events = parseEvents(obj['events']);
    const now = this.#now();
    const secret = this.#newSecret();
    const record: SubscriptionRecord = {
      id: this.#newId(),
      tenant: caller.tenant,
      url,
      events,
      secrets: [secret],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.insert(record);
    return {
      status: 201,
      body: { ...view(record), secret },
      etag: etagOf(record.version),
      location: `/webhooks/${record.id}`,
    };
  }

  /** The tenant's subscriptions as views, without secrets, for the tenant export (UX-088). */
  async viewsOf(tenant: string): Promise<SubscriptionView[]> {
    return (await this.#store.list(tenant)).map(view);
  }

  /** `GET /webhooks`: the caller's subscriptions, without secrets. */
  async list(caller: Caller): Promise<Answer> {
    requireServiceCredential(caller);
    const rows = await this.#store.list(caller.tenant);
    return { status: 200, body: { items: rows.map(view) } };
  }

  /** `GET /webhooks/{id}`. */
  async get(caller: Caller, id: string): Promise<Answer> {
    requireServiceCredential(caller);
    const row = await this.#require(caller, id);
    return { status: 200, body: view(row), etag: etagOf(row.version) };
  }

  /**
   * `PATCH /webhooks/{id}`, with If-Match. Changes `url` or `events`, or rotates the secret:
   * `rotate: true` adds a second active secret and returns it once; `retire: true` drops the older
   * one. A second rotation while one is in progress is a conflict.
   */
  async update(caller: Caller, id: string, body: unknown, ifMatch: IfMatch): Promise<Answer> {
    requireServiceCredential(caller);
    const obj = bodyOf(body);
    refuseUnknown(obj, UPDATE_KEYS);
    if (obj['rotate'] !== undefined && typeof obj['rotate'] !== 'boolean')
      throw new ApiError('validation_failed', 'rotate is a boolean', {
        violations: [{ path: '/rotate', rule: 'a boolean' }],
      });
    if (obj['retire'] !== undefined && typeof obj['retire'] !== 'boolean')
      throw new ApiError('validation_failed', 'retire is a boolean', {
        violations: [{ path: '/retire', rule: 'a boolean' }],
      });
    if (obj['rotate'] === true && obj['retire'] === true)
      throw new ApiError('validation_failed', 'rotate and retire are not sent together', {
        violations: [{ path: '/retire', rule: 'not with rotate' }],
      });
    const current = await this.#require(caller, id);
    requireIfMatch(ifMatch, etagOf(current.version));
    let secrets = [...current.secrets];
    let issued: string | undefined;
    if (obj['rotate'] === true) {
      if (secrets.length >= 2)
        throw new ApiError('conflict', 'a rotation is in progress; retire the old secret first');
      issued = this.#newSecret();
      secrets = [...secrets, issued];
    }
    if (obj['retire'] === true) {
      if (secrets.length < 2) throw new ApiError('conflict', 'no rotation is in progress');
      secrets = secrets.slice(1);
    }
    const next: SubscriptionRecord = {
      ...current,
      url: obj['url'] === undefined ? current.url : parseUrl(obj['url']),
      events: obj['events'] === undefined ? current.events : parseEvents(obj['events']),
      secrets,
      version: current.version + 1,
      updatedAt: this.#now(),
    };
    if (!(await this.#store.replace(next, current.version)))
      throw new ApiError('precondition_failed', 'the resource changed since the ETag was read');
    return {
      status: 200,
      body: issued === undefined ? view(next) : { ...view(next), secret: issued },
      etag: etagOf(next.version),
    };
  }

  /** `DELETE /webhooks/{id}`, with If-Match: 204. */
  async remove(caller: Caller, id: string, ifMatch: IfMatch): Promise<Answer> {
    requireServiceCredential(caller);
    const current = await this.#require(caller, id);
    requireIfMatch(ifMatch, etagOf(current.version));
    await this.#store.remove(caller.tenant, id);
    return { status: 204 };
  }

  /** The secrets a delivery is signed with: the active set (PRO-070 criterion 3). */
  async activeSecrets(tenant: string, id: string): Promise<readonly string[]> {
    const row = await this.#store.get(tenant, id);
    if (!row) throw new ApiError('not_found', 'no such subscription');
    return [...row.secrets];
  }

  async #require(caller: Caller, id: string): Promise<SubscriptionRecord> {
    // A subscription of another tenant is not found, not forbidden (no existence leak).
    const row = await this.#store.get(caller.tenant, id);
    if (!row) throw new ApiError('not_found', 'no such subscription');
    return row;
  }
}
