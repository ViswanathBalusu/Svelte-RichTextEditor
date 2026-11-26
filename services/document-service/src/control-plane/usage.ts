/**
 * The usage figures of a tenant for one calendar month in UTC (`GET /usage`; UX-078 criterion 2;
 * 06 §12; 13 §10; owner decision 69).
 *
 * One non-negative whole number for each quota dimension, and nothing else: no document identifier,
 * no user and no content. The figures are the largest value reached in the month for the rate and
 * concurrency dimensions (connections, open documents, commits in a window, room CPU
 * milliseconds in a window, export jobs at once), the compile minutes used in the month (read from
 * the job queue, so they hold for every node), and the storage: the stored bytes now for the
 * current month, the last value recorded in the month for an earlier one.
 *
 * Proposed, not decided by the owner (docs/adr/0431-w3-UX-078-usage-and-quota-kind.md): the
 * peaks are recorded where the live gate and the export route decide, in the memory of the node,
 * so they cover that node only and start again when it restarts. A figure for a month in which
 * the node recorded nothing is 0. A durable, cluster-wide record needs a table and a write path
 * that this story does not build.
 */
import type { QuotaDimension } from './quotas.ts';
import { monthOf } from './month.ts';

/** The dimensions whose figure is a peak or a level recorded by the node. */
export type RecordedDimension = Exclude<QuotaDimension, 'exportMinutes'>;

/** Where the gate and the routes report what they decided. */
export interface UsageRecorder {
  /** Keeps the largest value seen for the tenant in the current month. */
  peak(tenant: string, dimension: RecordedDimension, value: number): void;
  /** Keeps the last value seen for the tenant in the current month. */
  level(tenant: string, dimension: RecordedDimension, value: number): void;
}

const SEP = '\u0000';

/** The recorded peaks and levels of the node, per tenant, month and dimension. */
export class UsagePeaks implements UsageRecorder {
  readonly #values = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #key(tenant: string, month: string, dimension: string): string {
    return [tenant, month, dimension].join(SEP);
  }

  peak(tenant: string, dimension: RecordedDimension, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = this.#key(tenant, monthOf(this.#now()), dimension);
    const was = this.#values.get(key);
    if (was === undefined || value > was) this.#values.set(key, value);
  }

  level(tenant: string, dimension: RecordedDimension, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.#values.set(this.#key(tenant, monthOf(this.#now()), dimension), value);
  }

  /** The value recorded for a month, or 0. */
  read(tenant: string, month: string, dimension: RecordedDimension): number {
    return this.#values.get(this.#key(tenant, month, dimension)) ?? 0;
  }
}

export interface UsageSources {
  peaks: UsagePeaks;
  /** The bytes a tenant stores now; absent: the recorded level is the figure. */
  storedBytes?: (tenant: string) => Promise<number>;
  /** The compile minutes a tenant used in the month containing the Unix time `at`. */
  minutesUsed?: (tenant: string, at: number) => Promise<number>;
  now: () => number;
}

export interface TenantUsage {
  month: string;
  connections: number;
  openDocuments: number;
  commitRate: number;
  roomCpuBudget: number;
  storage: number;
  exportConcurrency: number;
  exportMinutes: number;
}

const MONTH = /^([0-9]{4})-(0[1-9]|1[0-2])$/;

export function isMonth(v: unknown): v is string {
  return typeof v === 'string' && MONTH.test(v);
}

const whole = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0);

export class UsageService {
  readonly #s: UsageSources;

  constructor(sources: UsageSources) {
    this.#s = sources;
  }

  /** The figures of the tenant in `month` (`YYYY-MM`, UTC); the current month when absent. */
  async read(tenant: string, month?: string): Promise<TenantUsage> {
    const now = this.#s.now();
    const current = monthOf(now);
    const m = month ?? current;
    const match = MONTH.exec(m);
    if (!match) throw new RangeError('the month is YYYY-MM');
    const { peaks } = this.#s;
    const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
    let storage = peaks.read(tenant, m, 'storage');
    if (m === current && this.#s.storedBytes) storage = await this.#s.storedBytes(tenant);
    const minutes = this.#s.minutesUsed ? await this.#s.minutesUsed(tenant, at) : 0;
    return {
      month: m,
      connections: whole(peaks.read(tenant, m, 'connections')),
      openDocuments: whole(peaks.read(tenant, m, 'openDocuments')),
      commitRate: whole(peaks.read(tenant, m, 'commitRate')),
      roomCpuBudget: whole(peaks.read(tenant, m, 'roomCpuBudget')),
      storage: whole(storage),
      exportConcurrency: whole(peaks.read(tenant, m, 'exportConcurrency')),
      exportMinutes: whole(minutes),
    };
  }
}
