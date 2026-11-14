/**
 * Live-use quota decisions per tenant (BE-091; 06 §12; 04 §12; 05 §5.8). The gate answers, before
 * the work, whether a connection, an open document, a commit or a CPU spend in a room is admitted,
 * and when it is refused, with the code and a retry delay. Each tenant has its own state, so one
 * tenant at its quota does not change another tenant's decisions.
 *
 * The values are read from the quota source at every decision, so a changed value applies to the
 * next decision (BE-091 criterion 3, once the administration API writes it).
 *
 * Codes (06 §12, 04 §12): exceeding connections, open documents, commit rate or storage is
 * `quota_exceeded`; a spent CPU budget in rooms is `rate_limited` with action `retry`, as 06 §12
 * states for the CPU budget. Refusals are counted per tenant and quota in `metrics` (BE-091
 * criterion 4 for the control-plane registry; the data plane's registry of BE-086 is not wired).
 *
 * Decisions taken here (the spec gives no figures; see docs/adr/0245-lane-BE-079-091.md):
 * - the commit rate and the CPU budget are counted over a sliding window of `windowMs`;
 * - the commit-rate quota is commits per window, the CPU budget is milliseconds per window;
 * - the retry delay of a count quota (connections, open documents) is `countRetryMs`, which the
 *   caller must set: no default is invented.
 *
 * Not built here: the socket and REST answers (`retryAfterMs`, `Retry-After`), which read these
 * decisions, and the storage and export quotas of BE-092.
 */
import type { Metrics } from './metrics.ts';
import type { QuotaDimension, QuotaSettings } from './quotas.ts';

/** Where the values come from: the quota store, read at each decision. */
export interface QuotaSource {
  get(tenant: string): QuotaSettings;
}

export const QUOTA_REFUSAL_METRIC = 'docedit_tenant_quota_refusals_total';

/**
 * The windows the node composes the gate with (BE-091; docs/adr/0245-lane-BE-079-091.md). The spec
 * gives no figures: these are settings of this lane, for the owner to confirm, not spec values.
 */
export const LIVE_QUOTA_WINDOW_MS = 60_000;
export const LIVE_QUOTA_COUNT_RETRY_MS = 1_000;

const HELP = 'Live-use quota refusals per tenant, quota and code (BE-091).';

export type Refusal =
  | {
      ok: false;
      code: 'quota_exceeded';
      quota: Exclude<QuotaDimension, 'roomCpuBudget'>;
      retryAfterMs: number;
    }
  | {
      ok: false;
      code: 'rate_limited';
      quota: 'roomCpuBudget';
      action: 'retry';
      retryAfterMs: number;
    };

export type Admission = { ok: true } | Refusal;

export interface LiveQuotaOptions {
  quotas: QuotaSource;
  metrics?: Metrics;
  now?: () => number;
  /** The sliding window of the commit rate and the CPU budget, in milliseconds (a whole number above 0). */
  windowMs: number;
  /** The retry delay for a count quota, in milliseconds (a whole number above 0). */
  countRetryMs: number;
}

interface TenantState {
  connections: number;
  docs: Set<string>;
  commits: number[];
  cpu: Array<{ at: number; ms: number }>;
}

function positiveInteger(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v <= 0) throw new RangeError(`${name} is a whole number above 0`);
}

export class LiveQuotas {
  readonly #quotas: QuotaSource;
  readonly #metrics: Metrics | undefined;
  readonly #now: () => number;
  readonly #windowMs: number;
  readonly #countRetryMs: number;
  readonly #tenants = new Map<string, TenantState>();

  constructor(opts: LiveQuotaOptions) {
    positiveInteger('windowMs', opts.windowMs);
    positiveInteger('countRetryMs', opts.countRetryMs);
    this.#quotas = opts.quotas;
    this.#metrics = opts.metrics;
    this.#now = opts.now ?? Date.now;
    this.#windowMs = opts.windowMs;
    this.#countRetryMs = opts.countRetryMs;
  }

  #state(tenant: string): TenantState {
    let s = this.#tenants.get(tenant);
    if (!s)
      this.#tenants.set(tenant, (s = { connections: 0, docs: new Set(), commits: [], cpu: [] }));
    return s;
  }

  #prune(s: TenantState, now: number): void {
    const from = now - this.#windowMs;
    s.commits = s.commits.filter((at) => at > from);
    s.cpu = s.cpu.filter((e) => e.at > from);
  }

  #refuse(tenant: string, refusal: Refusal): Refusal {
    this.#metrics?.inc(QUOTA_REFUSAL_METRIC, HELP, {
      tenant,
      quota: refusal.quota,
      code: refusal.code,
    });
    return refusal;
  }

  /** A connection of a tenant (`connections`). Each admitted one must be released. */
  admitConnection(tenant: string): Admission {
    const s = this.#state(tenant);
    const limit = this.#quotas.get(tenant).connections;
    if (limit !== null && s.connections + 1 > limit)
      return this.#refuse(tenant, {
        ok: false,
        code: 'quota_exceeded',
        quota: 'connections',
        retryAfterMs: this.#countRetryMs,
      });
    s.connections += 1;
    return { ok: true };
  }

  releaseConnection(tenant: string): void {
    const s = this.#state(tenant);
    s.connections = Math.max(0, s.connections - 1);
  }

  /** A document opened by a tenant (`openDocuments`). Opening one that is already open is admitted. */
  admitDocument(tenant: string, doc: string): Admission {
    const s = this.#state(tenant);
    if (s.docs.has(doc)) return { ok: true };
    const limit = this.#quotas.get(tenant).openDocuments;
    if (limit !== null && s.docs.size + 1 > limit)
      return this.#refuse(tenant, {
        ok: false,
        code: 'quota_exceeded',
        quota: 'openDocuments',
        retryAfterMs: this.#countRetryMs,
      });
    s.docs.add(doc);
    return { ok: true };
  }

  closeDocument(tenant: string, doc: string): void {
    this.#state(tenant).docs.delete(doc);
  }

  /** One commit of a tenant (`commitRate`, commits per window). */
  admitCommit(tenant: string): Admission {
    const now = this.#now();
    const s = this.#state(tenant);
    this.#prune(s, now);
    const limit = this.#quotas.get(tenant).commitRate;
    if (limit !== null && s.commits.length + 1 > limit) {
      const oldest = s.commits[0] ?? now;
      return this.#refuse(tenant, {
        ok: false,
        code: 'quota_exceeded',
        quota: 'commitRate',
        retryAfterMs: Math.max(1, oldest + this.#windowMs - now),
      });
    }
    s.commits.push(now);
    return { ok: true };
  }

  /** `ms` of room CPU spent for a tenant (`roomCpuBudget`, milliseconds per window). Refused as `rate_limited`. */
  spendCpu(tenant: string, ms: number): Admission {
    if (!Number.isFinite(ms) || ms < 0)
      throw new RangeError('a CPU spend is a finite number of zero or more');
    const now = this.#now();
    const s = this.#state(tenant);
    this.#prune(s, now);
    const limit = this.#quotas.get(tenant).roomCpuBudget;
    const spent = s.cpu.reduce((sum, e) => sum + e.ms, 0);
    if (limit !== null && spent + ms > limit) {
      const oldest = s.cpu[0]?.at ?? now;
      return this.#refuse(tenant, {
        ok: false,
        code: 'rate_limited',
        quota: 'roomCpuBudget',
        action: 'retry',
        retryAfterMs: Math.max(1, oldest + this.#windowMs - now),
      });
    }
    s.cpu.push({ at: now, ms });
    return { ok: true };
  }
}
