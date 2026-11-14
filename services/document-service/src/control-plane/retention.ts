/**
 * Retention policies of a tenant and of a document (UX-080 criteria 1 and 4; 08 section 11; 13
 * section 10; 05 section 6.2).
 *
 * The prose gives two behaviours and no field names or periods: the default keeps everything, and
 * a tenant may choose to thin payloads after a period. The policy shape here (`mode`, `afterDays`)
 * is a proposal, recorded in docs/adr/0330-lane-U-UX-076-090.md, section 6. The effective policy
 * of a document is its own policy, else the tenant's, else `keep_all`; whether a document policy
 * may be less strict than the tenant's is not specified and is not checked here.
 *
 * Each scope (the tenant, or one document) has a version: 0 while no policy is set, then one more
 * for each change. The ETag is the version, so `If-Match` names the version that was read, as the
 * other administration resources do (05 section 6.1).
 *
 * Every change is audited with its previous and new policy (kind `retention.changed`), after the
 * change is stored, as the classification label is (UX-085 criterion 4). The audit is therefore not
 * atomic with the change yet.
 *
 * The hold part of UX-080 (criteria 2 and 3) is not here: the hold rule lives in `@docedit/history`,
 * which this service does not depend on.
 */
import { uuid7 } from '@docedit/model';
import type { AuditStore } from '../storage/types.ts';
import { ApiError } from './problems.ts';

export const RETENTION_MODES = ['keep_all', 'thin_payloads'] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];

export interface RetentionPolicy {
  readonly mode: RetentionMode;
  /** Days after which commit payloads are thinned. Present with `thin_payloads`, absent otherwise. */
  readonly afterDays?: number;
}

export const KEEP_ALL: RetentionPolicy = Object.freeze({ mode: 'keep_all' });

export type PolicySource = 'document' | 'tenant' | 'default';

function fail(message: string): never {
  throw new ApiError('validation_failed', message);
}

/** The entity tag of a version. */
export function etagOf(version: number): string {
  return `"${version}"`;
}

/**
 * Checks a policy from a request body. Unknown fields, a missing or non-integer `afterDays` with
 * `thin_payloads`, and any `afterDays` with `keep_all` are refused with `validation_failed`.
 */
export function checkRetentionPolicy(value: unknown): RetentionPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('a retention policy is an object');
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== 'mode' && key !== 'afterDays') fail(`the retention policy has no field ${key}`);
  }
  if (o['mode'] === 'keep_all') {
    if (o['afterDays'] !== undefined) fail('keep_all keeps every payload, so afterDays is refused');
    return { mode: 'keep_all' };
  }
  if (o['mode'] !== 'thin_payloads') fail('mode is keep_all or thin_payloads');
  const days = o['afterDays'];
  if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1)
    fail('afterDays is a whole number of days, 1 or more');
  return { mode: 'thin_payloads', afterDays: days };
}

export interface RetentionRow {
  readonly policy: RetentionPolicy;
  readonly version: number;
}

/** A write that found the stored version other than the one the caller read. */
export class RetentionConflict extends Error {
  override name = 'RetentionConflict';
}

/** Storage of the policies. `document` null is the tenant's own policy. */
export interface RetentionStore {
  read(tenant: string, document: string | null): Promise<RetentionRow | null>;
  /**
   * Stores a policy when the stored version is `expected` (0 while none is set). Returns the new
   * version. Otherwise refuses with `RetentionConflict` and writes nothing.
   */
  write(
    tenant: string,
    document: string | null,
    policy: RetentionPolicy,
    expected: number,
  ): Promise<number>;
}

export class MemoryRetentionStore implements RetentionStore {
  readonly #rows = new Map<string, RetentionRow>();

  #key(tenant: string, document: string | null): string {
    return `${tenant}\u0000${document ?? ''}`;
  }

  async read(tenant: string, document: string | null): Promise<RetentionRow | null> {
    return this.#rows.get(this.#key(tenant, document)) ?? null;
  }

  async write(
    tenant: string,
    document: string | null,
    policy: RetentionPolicy,
    expected: number,
  ): Promise<number> {
    const key = this.#key(tenant, document);
    const current = this.#rows.get(key)?.version ?? 0;
    if (current !== expected) throw new RetentionConflict('the policy changed since it was read');
    this.#rows.set(key, { policy, version: current + 1 });
    return current + 1;
  }
}

export interface RetentionServiceDeps {
  store: RetentionStore;
  /** The audit trail the changes are written to (kind `retention.changed`). */
  audit: AuditStore;
  /**
   * Whether a document exists in the tenant. A document of another tenant answers false, so that
   * its identifier reveals nothing to this tenant.
   */
  documentExists: (tenant: string, document: string) => Promise<boolean>;
  now: () => number;
}

export interface TenantPolicyState {
  readonly policy: RetentionPolicy;
  readonly version: number;
}

export interface DocumentPolicyState {
  /** The document's own policy, or null when it carries none. */
  readonly policy: RetentionPolicy | null;
  /** The policy that applies to the document. */
  readonly effective: RetentionPolicy;
  readonly source: PolicySource;
  /** The version of the document's own policy (0 while none is set). */
  readonly version: number;
}

export class RetentionService {
  readonly #store: RetentionStore;
  readonly #audit: AuditStore;
  readonly #exists: (tenant: string, document: string) => Promise<boolean>;
  readonly #now: () => number;

  constructor(deps: RetentionServiceDeps) {
    this.#store = deps.store;
    this.#audit = deps.audit;
    this.#exists = deps.documentExists;
    this.#now = deps.now;
  }

  /** The tenant's policy; `keep_all` at version 0 while none is set. */
  async tenant(tenant: string): Promise<TenantPolicyState> {
    const row = await this.#store.read(tenant, null);
    return row ? { policy: row.policy, version: row.version } : { policy: KEEP_ALL, version: 0 };
  }

  /** Sets the tenant's policy. `expected` is the version the caller read. */
  async setTenant(
    tenant: string,
    actor: string,
    value: unknown,
    expected: number,
  ): Promise<{ previous: RetentionPolicy; state: TenantPolicyState }> {
    const policy = checkRetentionPolicy(value);
    const before = await this.tenant(tenant);
    const version = await this.#write(tenant, null, policy, expected);
    await this.#audited(tenant, null, actor, 'tenant', before.policy, policy);
    return { previous: before.policy, state: { policy, version } };
  }

  /** A document's own policy with the effective one. Not found for a document of another tenant. */
  async document(tenant: string, document: string): Promise<DocumentPolicyState> {
    await this.#known(tenant, document);
    const own = await this.#store.read(tenant, document);
    if (own)
      return {
        policy: own.policy,
        effective: own.policy,
        source: 'document',
        version: own.version,
      };
    const t = await this.tenant(tenant);
    if (t.version > 0) return { policy: null, effective: t.policy, source: 'tenant', version: 0 };
    return { policy: null, effective: KEEP_ALL, source: 'default', version: 0 };
  }

  /** Sets a document's policy. `expected` is the document's version the caller read. */
  async setDocument(
    tenant: string,
    document: string,
    actor: string,
    value: unknown,
    expected: number,
  ): Promise<DocumentPolicyState & { previous: RetentionPolicy | null }> {
    const policy = checkRetentionPolicy(value);
    const before = await this.document(tenant, document);
    const version = await this.#write(tenant, document, policy, expected);
    await this.#audited(tenant, document, actor, 'document', before.policy, policy);
    return {
      policy,
      effective: policy,
      source: 'document',
      version,
      previous: before.policy,
    };
  }

  async #known(tenant: string, document: string): Promise<void> {
    if (!(await this.#exists(tenant, document)))
      throw new ApiError('not_found', 'no such document');
  }

  async #write(
    tenant: string,
    document: string | null,
    policy: RetentionPolicy,
    expected: number,
  ): Promise<number> {
    try {
      return await this.#store.write(tenant, document, policy, expected);
    } catch (e) {
      if (e instanceof RetentionConflict)
        throw new ApiError('precondition_failed', 'the policy changed since the ETag was read');
      throw e;
    }
  }

  async #audited(
    tenant: string,
    document: string | null,
    actor: string,
    scope: 'tenant' | 'document',
    previous: RetentionPolicy | null,
    policy: RetentionPolicy,
  ): Promise<void> {
    await this.#audit.record([
      {
        id: uuid7(),
        tenant,
        doc: document,
        actor,
        kind: 'retention.changed',
        data: { scope, previous, policy },
        at: this.#now(),
      },
    ]);
  }
}
