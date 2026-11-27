/**
 * Who sees full history, set per tenant and per document (HIS-025 criteria 5 and 6; 08 section 9;
 * 13 section 10; ADR 0034 section 2).
 *
 * The rule of ADR 0034: a document's own setting wins over the tenant's, the tenant's is the
 * default for documents without one, and without either the answer is `editors` (the value of the
 * column `documents.history_visibility`, 06 section 4.1). Only a service credential reaches the
 * routes (the pipeline refuses a user token before the handler runs), which is the administration
 * API of 13 section 10: the host's tenant administrator holds it. Every change is audited with the
 * actor (kind `history_visibility.changed`) after it is stored, as the retention policy is
 * (retention.ts), so the audit is not atomic with the change yet.
 *
 * A change applies to the next request. The gate is evaluated when a request arrives, so nothing
 * is rewritten and nothing already delivered is recalled. To make the next request see it, the
 * document store the service hands to the gate and the rooms is wrapped by
 * `withEffectiveHistoryVisibility`: every record it returns carries the effective setting.
 *
 * Each scope (the tenant, or one document) has a version, 0 while no setting is set and one more
 * for each change. It is the ETag, so `If-Match` names the version that was read (05 section 6.1).
 */
import { uuid7 } from '@docedit/model';
import {
  DEFAULT_HISTORY_VISIBILITY,
  HISTORY_VISIBILITIES,
  type HistoryVisibility,
} from '@docedit/authority';
import type { AuditStore, DocRef, DocumentRecord, DocumentStore } from '../storage/types.ts';
import { ApiError } from './problems.ts';

export type VisibilitySource = 'document' | 'tenant' | 'default';

export interface VisibilityRow {
  readonly setting: HistoryVisibility;
  readonly version: number;
}

/** A write that found the stored version other than the one the caller read. */
export class VisibilityConflict extends Error {
  override name = 'VisibilityConflict';
}

/** Storage of the settings. `document` null is the tenant's own setting. */
export interface VisibilityStore {
  read(tenant: string, document: string | null): Promise<VisibilityRow | null>;
  /**
   * Stores a setting when the stored version is `expected` (0 while none is set). Returns the new
   * version. Otherwise refuses with `VisibilityConflict` and writes nothing.
   */
  write(
    tenant: string,
    document: string | null,
    setting: HistoryVisibility,
    expected: number,
  ): Promise<number>;
  /**
   * The settings that apply to these documents of one tenant, each the document's own setting,
   * else the tenant's, else absent (the column's value then stands). One round trip.
   */
  effective(
    tenant: string,
    documents: readonly string[],
  ): Promise<Map<string, { setting: HistoryVisibility; source: 'document' | 'tenant' }>>;
}

export class MemoryVisibilityStore implements VisibilityStore {
  readonly #rows = new Map<string, VisibilityRow>();

  #key(tenant: string, document: string | null): string {
    return `${tenant}\u0000${document ?? ''}`;
  }

  async read(tenant: string, document: string | null): Promise<VisibilityRow | null> {
    return this.#rows.get(this.#key(tenant, document)) ?? null;
  }

  async write(
    tenant: string,
    document: string | null,
    setting: HistoryVisibility,
    expected: number,
  ): Promise<number> {
    const key = this.#key(tenant, document);
    const current = this.#rows.get(key)?.version ?? 0;
    if (current !== expected) throw new VisibilityConflict('the setting changed since it was read');
    this.#rows.set(key, { setting, version: current + 1 });
    return current + 1;
  }

  async effective(
    tenant: string,
    documents: readonly string[],
  ): Promise<Map<string, { setting: HistoryVisibility; source: 'document' | 'tenant' }>> {
    const out = new Map<string, { setting: HistoryVisibility; source: 'document' | 'tenant' }>();
    const tenantRow = this.#rows.get(this.#key(tenant, null));
    for (const doc of documents) {
      const own = this.#rows.get(this.#key(tenant, doc));
      if (own) out.set(doc, { setting: own.setting, source: 'document' });
      else if (tenantRow) out.set(doc, { setting: tenantRow.setting, source: 'tenant' });
    }
    return out;
  }
}

function fail(message: string): never {
  throw new ApiError('validation_failed', message);
}

/** The entity tag of a version. */
export function visibilityEtag(version: number): string {
  return `"${version}"`;
}

/** Checks a setting from a request body: an object with `setting` and nothing else. */
export function checkVisibilitySetting(value: unknown): HistoryVisibility {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('a history visibility setting is an object');
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o))
    if (key !== 'setting') fail(`the history visibility setting has no field ${key}`);
  const s = o['setting'];
  if (typeof s !== 'string' || !(HISTORY_VISIBILITIES as readonly string[]).includes(s))
    fail(`setting is one of ${HISTORY_VISIBILITIES.join(', ')}`);
  return s as HistoryVisibility;
}

export interface VisibilityServiceDeps {
  store: VisibilityStore;
  audit: AuditStore;
  /** Whether a document exists in the tenant (another tenant's document answers false). */
  documentExists: (tenant: string, document: string) => Promise<boolean>;
  now: () => number;
}

export interface TenantVisibilityState {
  readonly setting: HistoryVisibility;
  readonly version: number;
}

export interface DocumentVisibilityState {
  /** The document's own setting, or null when it carries none. */
  readonly setting: HistoryVisibility | null;
  readonly effective: HistoryVisibility;
  readonly source: VisibilitySource;
  /** The version of the document's own setting (0 while none is set). */
  readonly version: number;
}

export class HistoryVisibilityService {
  readonly #store: VisibilityStore;
  readonly #audit: AuditStore;
  readonly #exists: (tenant: string, document: string) => Promise<boolean>;
  readonly #now: () => number;

  constructor(deps: VisibilityServiceDeps) {
    this.#store = deps.store;
    this.#audit = deps.audit;
    this.#exists = deps.documentExists;
    this.#now = deps.now;
  }

  /** The tenant's setting; `editors` at version 0 while none is set. */
  async tenant(tenant: string): Promise<TenantVisibilityState> {
    const row = await this.#store.read(tenant, null);
    return row
      ? { setting: row.setting, version: row.version }
      : { setting: DEFAULT_HISTORY_VISIBILITY, version: 0 };
  }

  async setTenant(
    tenant: string,
    actor: string,
    value: unknown,
    expected: number,
  ): Promise<TenantVisibilityState> {
    const setting = checkVisibilitySetting(value);
    const before = await this.tenant(tenant);
    const version = await this.#write(tenant, null, setting, expected);
    await this.#audited(
      tenant,
      null,
      actor,
      'tenant',
      before.version === 0 ? null : before.setting,
      setting,
    );
    return { setting, version };
  }

  /** A document's own setting with the effective one. Not found for another tenant's document. */
  async document(tenant: string, document: string): Promise<DocumentVisibilityState> {
    if (!(await this.#exists(tenant, document)))
      throw new ApiError('not_found', 'no such document');
    const own = await this.#store.read(tenant, document);
    if (own)
      return {
        setting: own.setting,
        effective: own.setting,
        source: 'document',
        version: own.version,
      };
    const t = await this.#store.read(tenant, null);
    if (t) return { setting: null, effective: t.setting, source: 'tenant', version: 0 };
    return { setting: null, effective: DEFAULT_HISTORY_VISIBILITY, source: 'default', version: 0 };
  }

  async setDocument(
    tenant: string,
    document: string,
    actor: string,
    value: unknown,
    expected: number,
  ): Promise<DocumentVisibilityState> {
    const setting = checkVisibilitySetting(value);
    const before = await this.document(tenant, document);
    const version = await this.#write(tenant, document, setting, expected);
    await this.#audited(tenant, document, actor, 'document', before.setting, setting);
    return { setting, effective: setting, source: 'document', version };
  }

  async #write(
    tenant: string,
    document: string | null,
    setting: HistoryVisibility,
    expected: number,
  ): Promise<number> {
    try {
      return await this.#store.write(tenant, document, setting, expected);
    } catch (e) {
      if (e instanceof VisibilityConflict)
        throw new ApiError('precondition_failed', 'the setting changed since the ETag was read');
      throw e;
    }
  }

  async #audited(
    tenant: string,
    document: string | null,
    actor: string,
    scope: 'tenant' | 'document',
    previous: HistoryVisibility | null,
    setting: HistoryVisibility,
  ): Promise<void> {
    await this.#audit.record([
      {
        id: uuid7(),
        tenant,
        doc: document,
        actor,
        kind: 'history_visibility.changed',
        data: { scope, previous, setting },
        at: this.#now(),
      },
    ]);
  }
}

async function withSetting(
  store: VisibilityStore,
  records: readonly DocumentRecord[],
): Promise<DocumentRecord[]> {
  const out: DocumentRecord[] = [];
  const byTenant = new Map<string, DocumentRecord[]>();
  for (const r of records) byTenant.set(r.tenant, [...(byTenant.get(r.tenant) ?? []), r]);
  const found = new Map<string, { setting: HistoryVisibility }>();
  for (const [tenant, list] of byTenant)
    for (const [doc, v] of await store.effective(
      tenant,
      list.map((r) => r.id),
    ))
      found.set(`${tenant}\u0000${doc}`, v);
  for (const r of records) {
    const v = found.get(`${r.tenant}\u0000${r.id}`);
    out.push(v ? { ...r, historyVisibility: v.setting } : r);
  }
  return out;
}

/**
 * A document store whose records carry the effective history visibility (document, else tenant,
 * else the stored column), read when the record is read, so a change applies to the next request.
 * Every other behaviour is the inner store's.
 */
export function withEffectiveHistoryVisibility(
  inner: DocumentStore,
  store: VisibilityStore,
): DocumentStore {
  const one = async (r: DocumentRecord): Promise<DocumentRecord> =>
    (await withSetting(store, [r]))[0]!;
  return {
    create: async (tenant, input) => one(await inner.create(tenant, input)),
    get: async (ref: DocRef) => {
      const r = await inner.get(ref);
      return r ? one(r) : null;
    },
    list: async (tenant, query) => withSetting(store, await inner.list(tenant, query)),
    update: async (ref, patch, opts) => {
      const r = await inner.update(ref, patch, opts);
      return { ...r, record: await one(r.record) };
    },
    remove: async (ref, opts) => one(await inner.remove(ref, opts)),
    setCdmVersion: (ref, from, to) => inner.setCdmVersion(ref, from, to),
  };
}
