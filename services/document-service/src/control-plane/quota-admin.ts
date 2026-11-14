/**
 * The tenant quota values of `/quotas` (UX-078 criterion 1 and 4; 06 section 12; 13 section 10).
 *
 * The values are stored by `MemoryQuotaStore` (quotas.ts) or `PgQuotaStore` (quotas-pg.ts); this
 * service adds the operator's write path: a request body is checked as a whole before any value is
 * written, so a refused body writes nothing, and each change that alters the settings is audited
 * (kind `quota.changed`) with the previous and the new values, after the change is stored, as the
 * retention policies are (UX-080). The audit is therefore not atomic with the change yet.
 *
 * Decisions, proposed in docs/adr/0330-lane-V-UX-076-090.md, section 6 (the spec gives no contract
 * for the values): the route accepts whole numbers only, although the stores accept any finite
 * number of zero or more; a `PUT` sets the dimensions it names and keeps the others; the entity tag
 * is a hash of the settings, so `If-Match` names the settings that were read.
 */
import { createHash } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import type { AuditStore } from '../storage/types.ts';
import { ApiError } from './problems.ts';
import {
  isQuotaDimension,
  QUOTA_DIMENSIONS,
  QuotaError,
  type QuotaDimension,
  type QuotaSettings,
} from './quotas.ts';

/** The storage of the values: the memory or the PostgreSQL store. Either may answer synchronously. */
export interface QuotaAdminStore {
  get(tenant: string): Promise<QuotaSettings> | QuotaSettings;
  set(tenant: string, dimension: QuotaDimension, value: number): Promise<number> | number;
}

export interface QuotaAdminDeps {
  store: QuotaAdminStore;
  /** The audit trail the changes are written to (kind `quota.changed`). */
  audit: AuditStore;
  now: () => number;
}

function fail(message: string): never {
  throw new ApiError('validation_failed', message);
}

/** The entity tag of a settings value: a hash of its dimensions and values, in dimension order. */
export function quotaEtag(settings: QuotaSettings): string {
  const canonical = JSON.stringify(QUOTA_DIMENSIONS.map((d) => [d, settings[d]]));
  return `"${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}"`;
}

/**
 * Checks a request body: an object whose keys are quota dimensions and whose values are whole
 * numbers of zero or more. Any other key or value is refused with `validation_failed`.
 */
export function checkQuotaUpdate(value: unknown): Partial<Record<QuotaDimension, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('the quota values are an object');
  const out: Partial<Record<QuotaDimension, number>> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!isQuotaDimension(key)) fail(`the quota dimension ${key} is not known`);
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
      fail(`${key} is a whole number, 0 or more`);
    out[key] = v;
  }
  return out;
}

export class QuotaAdminService {
  readonly #store: QuotaAdminStore;
  readonly #audit: AuditStore;
  readonly #now: () => number;

  constructor(deps: QuotaAdminDeps) {
    this.#store = deps.store;
    this.#audit = deps.audit;
    this.#now = deps.now;
  }

  /** The tenant's quota values; null for each dimension with no value. */
  async get(tenant: string): Promise<QuotaSettings> {
    return await this.#store.get(tenant);
  }

  /**
   * Sets the dimensions the body names. The body is checked whole before any value is written. A
   * change that alters the settings is audited with the previous and the new values.
   */
  async set(
    tenant: string,
    actor: string,
    value: unknown,
  ): Promise<{ previous: QuotaSettings; settings: QuotaSettings }> {
    const values = checkQuotaUpdate(value);
    const previous = await this.get(tenant);
    try {
      for (const d of QUOTA_DIMENSIONS) {
        const v = values[d];
        if (v !== undefined) await this.#store.set(tenant, d, v);
      }
    } catch (e) {
      if (e instanceof QuotaError) throw new ApiError('not_found', e.message);
      throw e;
    }
    const settings = await this.get(tenant);
    if (JSON.stringify(previous) !== JSON.stringify(settings)) {
      await this.#audit.record([
        {
          id: uuid7(),
          tenant,
          doc: null,
          actor,
          kind: 'quota.changed',
          data: { previous, settings },
          at: this.#now(),
        },
      ]);
    }
    return { previous, settings };
  }
}
