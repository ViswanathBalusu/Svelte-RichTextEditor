/**
 * Metrics per node and per tenant (06 §11; BE-086): acknowledgement latency, persist batch size and
 * latency, rebase rate, rejections by code, open rooms, memory per room, send-queue depth, catch-up
 * sizes and cold-open time, and the data plane's own counters (checkpoints, slow consumers, rate
 * limits, outbox deliveries). Exposed in the Prometheus text format.
 *
 * Every label is an identifier or a registry code: the node, the tenant, a code, a kind. Nothing
 * that a client or a document supplies as text becomes a label or a value (BE-086 criterion 4).
 *
 * The node labels every series. Every series about a room, a document, a channel or an identified
 * session also carries the tenant (BE-086 criterion 2). Before `hello` no tenant is known: the
 * address rate limits and the share of sessions not yet identified are series with the node label
 * only. A tenant label is never empty.
 */

type Labels = Readonly<Record<string, string>>;

const LABEL = /^[a-z_][a-z0-9_]*$/;

function escapeValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join('\u0000');
}

function render(labels: Labels): string {
  const names = Object.keys(labels).sort();
  if (!names.length) return '';
  return `{${names.map((n) => `${n}="${escapeValue(labels[n]!)}"`).join(',')}}`;
}

interface Series<T> {
  labels: Labels;
  value: T;
}

abstract class Metric<T> {
  readonly name: string;
  readonly help: string;
  protected readonly series = new Map<string, Series<T>>();
  readonly #base: Labels;

  constructor(name: string, help: string, base: Labels) {
    this.name = name;
    this.help = help;
    this.#base = base;
  }

  protected entry(labels: Labels, init: () => T): Series<T> {
    for (const k of Object.keys(labels))
      if (!LABEL.test(k)) throw new Error(`metric ${this.name}: bad label ${k}`);
    if (labels['tenant'] === '') throw new Error(`metric ${this.name}: empty tenant label`);
    const all = { ...this.#base, ...labels };
    const k = key(all);
    let s = this.series.get(k);
    if (!s) {
      s = { labels: all, value: init() };
      this.series.set(k, s);
    }
    return s;
  }

  abstract lines(): string[];
}

export class Counter extends Metric<number> {
  inc(labels: Labels = {}, by = 1): void {
    this.entry(labels, () => 0).value += by;
  }

  get(labels: Labels = {}): number {
    return this.entry(labels, () => 0).value;
  }

  lines(): string[] {
    return [...this.series.values()].map((s) => `${this.name}${render(s.labels)} ${s.value}`);
  }
}

export class Gauge extends Metric<number> {
  readonly #collect: (() => Array<{ labels: Labels; value: number }>) | undefined;

  constructor(
    name: string,
    help: string,
    base: Labels,
    collect?: () => Array<{ labels: Labels; value: number }>,
  ) {
    super(name, help, base);
    this.#collect = collect;
  }

  set(labels: Labels, value: number): void {
    this.entry(labels, () => 0).value = value;
  }

  lines(): string[] {
    if (this.#collect) {
      this.series.clear();
      for (const s of this.#collect()) this.set(s.labels, s.value);
    }
    return [...this.series.values()].map((s) => `${this.name}${render(s.labels)} ${s.value}`);
  }
}

interface Buckets {
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram extends Metric<Buckets> {
  readonly bounds: readonly number[];

  constructor(name: string, help: string, base: Labels, bounds: readonly number[]) {
    super(name, help, base);
    this.bounds = [...bounds].sort((a, b) => a - b);
  }

  observe(labels: Labels, v: number): void {
    const b = this.entry(labels, () => ({
      counts: this.bounds.map(() => 0),
      sum: 0,
      count: 0,
    })).value;
    for (let i = 0; i < this.bounds.length; i++) if (v <= this.bounds[i]!) b.counts[i]!++;
    b.sum += v;
    b.count++;
  }

  /** The observations of one series, for tests. */
  stats(labels: Labels = {}): { count: number; sum: number } {
    const b = this.entry(labels, () => ({ counts: this.bounds.map(() => 0), sum: 0, count: 0 }));
    return { count: b.value.count, sum: b.value.sum };
  }

  lines(): string[] {
    const out: string[] = [];
    for (const s of this.series.values()) {
      this.bounds.forEach((le, i) =>
        out.push(
          `${this.name}_bucket${render({ ...s.labels, le: String(le) })} ${s.value.counts[i]}`,
        ),
      );
      out.push(`${this.name}_bucket${render({ ...s.labels, le: '+Inf' })} ${s.value.count}`);
      out.push(`${this.name}_sum${render(s.labels)} ${s.value.sum}`);
      out.push(`${this.name}_count${render(s.labels)} ${s.value.count}`);
    }
    return out;
  }
}

const MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];
const SIZES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];

/** The data plane's metrics; `node` labels every series (06 §11). */
export class Metrics {
  readonly node: string;
  readonly #all: Array<{ name: string; help: string; lines(): string[] }> = [];

  readonly ackLatency: Histogram;
  readonly persistBatch: Histogram;
  readonly persistLatency: Histogram;
  readonly commits: Counter;
  readonly rebased: Counter;
  readonly rejections: Counter;
  readonly catchUp: Counter;
  readonly catchUpCommits: Histogram;
  readonly coldOpen: Histogram;
  readonly checkpoints: Counter;
  readonly checkpointFailures: Counter;
  readonly checkpointLatency: Histogram;
  readonly slowConsumers: Counter;
  readonly rateLimited: Counter;
  readonly outbox: Counter;
  readonly roomsClosed: Counter;
  readonly writeFailures: Counter;
  /** Seconds rooms stayed open, per tenant (BE-085 criterion 1: open-room time). */
  readonly roomOpenSeconds: Counter;
  /** Seconds identified connections stayed open, per tenant (BE-085 criterion 1: connection time). */
  readonly connectionSeconds: Counter;

  constructor(node: string) {
    this.node = node;
    const base = { node };
    const h = (name: string, help: string, bounds: readonly number[]) =>
      this.#add(new Histogram(name, help, base, bounds));
    const c = (name: string, help: string) => this.#add(new Counter(name, help, base));
    this.ackLatency = h(
      'dep_ack_latency_ms',
      'Time from a submit arriving to its acknowledgement being sent, ms',
      MS,
    );
    this.persistBatch = h('dep_persist_batch_commits', 'Commits per log write', SIZES);
    this.persistLatency = h('dep_persist_latency_ms', 'Duration of a log write, ms', MS);
    this.commits = c('dep_commits_total', 'Commits stored');
    this.rebased = c('dep_commits_rebased_total', 'Commits stored after a rebase');
    this.rejections = c('dep_rejections_total', 'Commits rejected, by registry code');
    this.catchUp = c('dep_catch_up_total', 'Channel opens, by catch-up kind');
    this.catchUpCommits = h('dep_catch_up_commits', 'Commits streamed on a resume', SIZES);
    this.coldOpen = h('dep_cold_open_ms', 'Time to open a room from storage, ms', MS);
    this.checkpoints = c('dep_checkpoints_total', 'Checkpoints written');
    this.checkpointFailures = c('dep_checkpoint_failures_total', 'Checkpoint writes that failed');
    this.checkpointLatency = h('dep_checkpoint_ms', 'Time to write a checkpoint, ms', MS);
    this.slowConsumers = c('dep_slow_consumers_total', 'Channels closed with slow_consumer');
    this.rateLimited = c('dep_rate_limited_total', 'Messages refused by a rate limit, by scope');
    this.outbox = c('dep_outbox_items_total', 'Outbox items settled, by state');
    this.roomsClosed = c('dep_rooms_closed_total', 'Rooms closed, by reason');
    this.writeFailures = c('dep_write_failures_total', 'Log writes that did not store, by outcome');
    this.roomOpenSeconds = c('dep_room_open_seconds_total', 'Seconds rooms stayed open, by tenant');
    this.connectionSeconds = c(
      'dep_connection_seconds_total',
      'Seconds identified connections stayed open, by tenant',
    );
  }

  #add<M extends { name: string; help: string; lines(): string[] }>(m: M): M {
    this.#all.push(m);
    return m;
  }

  /** A gauge read when the metrics are scraped (open rooms, memory per room, queue depth). */
  gauge(
    name: string,
    help: string,
    collect: () => Array<{ labels: Labels; value: number }>,
  ): Gauge {
    return this.#add(new Gauge(name, help, { node: this.node }, collect));
  }

  /** The Prometheus text exposition format, version 0.0.4. */
  text(): string {
    const out: string[] = [];
    for (const m of this.#all) {
      const type = m instanceof Counter ? 'counter' : m instanceof Gauge ? 'gauge' : 'histogram';
      out.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${type}`, ...m.lines());
    }
    return `${out.join('\n')}\n`;
  }
}
