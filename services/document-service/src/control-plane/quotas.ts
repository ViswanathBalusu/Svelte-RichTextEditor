/**
 * Tenant quota settings (UX-078 criterion 1; 13 §10; 06 §12). A quota is one value per dimension and
 * tenant. The dimensions are the ones 06 section 12 lists: connections, open documents, commit rate,
 * room CPU budget, storage, export concurrency and export minutes, and the recipient rows of bulk
 * sends in a calendar month (owner decision 265; FRW-063). A value must be a finite,
 * non-negative number. No default value is set here: an unset dimension reads as `null`, because
 * the spec gives no figures.
 *
 * This is the in-memory store only. Durable storage and the administration write path (UX-076) are
 * not built, so the values last as long as the process.
 */

export const QUOTA_DIMENSIONS = [
  'connections',
  'openDocuments',
  'commitRate',
  'roomCpuBudget',
  'storage',
  'exportConcurrency',
  'exportMinutes',
  'bulkSendRows',
] as const;

export type QuotaDimension = (typeof QUOTA_DIMENSIONS)[number];

export type QuotaSettings = Readonly<Record<QuotaDimension, number | null>>;

export class QuotaError extends Error {
  override name = 'QuotaError';
}

export function isQuotaDimension(v: unknown): v is QuotaDimension {
  return typeof v === 'string' && (QUOTA_DIMENSIONS as readonly string[]).includes(v);
}

/** Checks a quota value: a finite number of zero or more. Throws a `QuotaError` otherwise. */
export function checkQuotaValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new QuotaError('a quota is a finite number of zero or more');
  return value;
}

export class MemoryQuotaStore {
  readonly #tenants: (tenant: string) => boolean;
  readonly #values = new Map<string, Partial<Record<QuotaDimension, number>>>();

  /** `known` answers whether a tenant is registered; a quota of an unknown tenant is refused. */
  constructor(known: (tenant: string) => boolean) {
    this.#tenants = known;
  }

  /** Sets one dimension of a tenant's quotas. Returns the value stored. */
  set(tenant: string, dimension: unknown, value: unknown): number {
    if (!this.#tenants(tenant)) throw new QuotaError('no such tenant');
    if (!isQuotaDimension(dimension)) throw new QuotaError('the quota dimension is not known');
    const v = checkQuotaValue(value);
    const current = this.#values.get(tenant) ?? {};
    this.#values.set(tenant, { ...current, [dimension]: v });
    return v;
  }

  /** Clears one dimension of a tenant's quotas: it reads as `null` again, no limit (owner decision 267). */
  clear(tenant: string, dimension: unknown): void {
    if (!this.#tenants(tenant)) throw new QuotaError('no such tenant');
    if (!isQuotaDimension(dimension)) throw new QuotaError('the quota dimension is not known');
    const { [dimension]: _removed, ...rest } = this.#values.get(tenant) ?? {};
    this.#values.set(tenant, rest);
  }

  /** The quotas of a tenant; every dimension is present and `null` when no value is set. */
  get(tenant: string): QuotaSettings {
    const current = this.#values.get(tenant) ?? {};
    const out = {} as Record<QuotaDimension, number | null>;
    for (const d of QUOTA_DIMENSIONS) out[d] = current[d] ?? null;
    return out;
  }
}
