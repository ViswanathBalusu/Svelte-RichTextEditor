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
import type { QuotaSource } from './live-quotas.ts';
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

/**
 * How long a node trusts the values it read, in milliseconds. A change written through this node
 * applies at once (write-through); a change another node wrote reaches this one within this time
 * (BE-091 criterion 3). A setting of this
 * lane, not a spec figure; see docs/adr/0370-w5-BE-091-quota-cache.md.
 */
export const QUOTA_CACHE_TTL_MS = 5_000;

function noQuotas(): QuotaSettings {
  const out = {} as Record<QuotaDimension, number | null>;
  for (const d of QUOTA_DIMENSIONS) out[d] = null;
  return out;
}

/**
 * The synchronous view of the stored quota values that the live-use gate reads at each decision
 * (live-quotas.ts). A store that answers at once (memory) is read directly. A store that answers
 * later (PostgreSQL) is read into a cache by `load`, which the gate calls before it decides at a
 * `hello` or a REST request, and which a stale entry starts in the background. Until a tenant has
 * been read, its values read as no quota.
 */
export class CachedQuotaSource implements QuotaSource {
  readonly #store: QuotaAdminStore;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #entries = new Map<string, { settings: QuotaSettings; at: number }>();
  readonly #loading = new Map<string, Promise<void>>();

  constructor(store: QuotaAdminStore, now: () => number, ttlMs: number = QUOTA_CACHE_TTL_MS) {
    this.#store = store;
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  /** Records values just read or written, so that the next decision uses them. */
  put(tenant: string, settings: QuotaSettings): void {
    this.#entries.set(tenant, { settings, at: this.#now() });
  }

  get(tenant: string): QuotaSettings {
    const e = this.#entries.get(tenant);
    if (e && this.#now() - e.at < this.#ttlMs) return e.settings;
    // Stale or unknown. A read already under way is waited for by the caller of `load`; the values
    // read last stay in force meanwhile (none read yet: no quota).
    if (this.#loading.has(tenant)) return e?.settings ?? noQuotas();
    // A store that answers at once is read now; one that answers later is read in the background.
    const direct = this.#store.get(tenant);
    if (!(direct instanceof Promise)) {
      this.put(tenant, direct);
      return direct;
    }
    this.#track(tenant, direct);
    return e?.settings ?? noQuotas();
  }

  #track(tenant: string, read: Promise<QuotaSettings>): Promise<void> {
    const p = read
      .then((s) => this.put(tenant, s))
      .catch(() => undefined)
      .finally(() => this.#loading.delete(tenant));
    this.#loading.set(tenant, p);
    return p;
  }

  /** Reads the tenant's values from the store into the cache. Reads of one tenant do not overlap; fresh values are kept. */
  async load(tenant: string): Promise<void> {
    const e = this.#entries.get(tenant);
    if (e && this.#now() - e.at < this.#ttlMs) return;
    const running = this.#loading.get(tenant);
    if (running) return await running;
    const read = this.#store.get(tenant);
    if (!(read instanceof Promise)) return this.put(tenant, read);
    await this.#track(tenant, read);
  }
}
export class QuotaAdminService {
  readonly #store: QuotaAdminStore;
  readonly #audit: AuditStore;
  readonly #now: () => number;
  /** The values as the live-use gate reads them; kept current by every read and write here. */
  readonly source: CachedQuotaSource;

  constructor(deps: QuotaAdminDeps) {
    this.#store = deps.store;
    this.#audit = deps.audit;
    this.#now = deps.now;
    this.source = new CachedQuotaSource(deps.store, deps.now);
  }

  /** The tenant's quota values; null for each dimension with no value. */
  async get(tenant: string): Promise<QuotaSettings> {
    const settings = await this.#store.get(tenant);
    this.source.put(tenant, settings);
    return settings;
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
