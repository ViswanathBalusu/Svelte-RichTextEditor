/**
 * Metrics of the control plane in the Prometheus text format (06 §11; BE-050 criterion 5, BE-052
 * criterion 3, BE-085; ADR 0054), served with the data plane's own metrics (BE-086) at `/metrics`.
 *
 * Labels carry identifiers and codes only: a tenant identifier, a job kind, a task name, a driver
 * name. No label or value holds document content, a field value or a token (BE-085 criterion 2).
 *
 * The tenant meter counts the cost drivers of 06 §10 per tenant (BE-085): what the control plane
 * sees itself (compiles and their duration, stored bytes of checkpoints, assets and exports) and,
 * through the decorators below, the commits and payload bytes of every log write and the
 * checkpoints of every writer, the data plane's included. Quotas (BE-091, BE-092) and the usage
 * figures of the administration interface (UX-076) read `read(tenant)`.
 */
import type { WriteRequest, WriteResult } from '@docedit/authority';
import type { JsonEnvelope } from '@docedit/model';
import type { AppendOptions, CheckpointStore, DocRef, LogStore } from '../storage/types.ts';

type Labels = Readonly<Record<string, string>>;

const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelText(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${escapeValue(labels[k]!)}"`).join(',')}}`;
}

interface Family {
  name: string;
  help: string;
  type: 'counter' | 'gauge';
  samples: Map<string, { labels: Labels; value: number }>;
  collect?: () => Promise<Array<{ labels: Labels; value: number }>>;
}

export class Metrics {
  readonly #families = new Map<string, Family>();
  /** Labels every series carries, such as the node (BE-086 criterion 2, V-BE-085-098). */
  readonly #base: Labels;

  constructor(base: Labels = {}) {
    for (const k of Object.keys(base)) if (!LABEL.test(k)) throw new RangeError(`bad label ${k}`);
    this.#base = { ...base };
  }

  #family(name: string, help: string, type: Family['type']): Family {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new RangeError(`bad metric name ${name}`);
    let f = this.#families.get(name);
    if (!f) this.#families.set(name, (f = { name, help, type, samples: new Map() }));
    return f;
  }

  /** Adds `n` to a counter. */
  inc(name: string, help: string, labels: Labels = {}, n = 1): void {
    for (const k of Object.keys(labels)) if (!LABEL.test(k)) throw new RangeError(`bad label ${k}`);
    const all = { ...this.#base, ...labels };
    const f = this.#family(name, help, 'counter');
    const key = labelText(all);
    const s = f.samples.get(key);
    if (s) s.value += n;
    else f.samples.set(key, { labels: all, value: n });
  }

  /** A gauge whose samples are read at each scrape. */
  gauge(
    name: string,
    help: string,
    collect: () => Promise<Array<{ labels: Labels; value: number }>>,
  ) {
    const base = this.#base;
    this.#family(name, help, 'gauge').collect = async () =>
      (await collect()).map((s) => ({ labels: { ...base, ...s.labels }, value: s.value }));
  }

  /** The current value of a counter sample, for tests and the meter. */
  value(name: string, labels: Labels = {}): number {
    return (
      this.#families.get(name)?.samples.get(labelText({ ...this.#base, ...labels }))?.value ?? 0
    );
  }

  /** Every sample of a family, for the meter. */
  samples(name: string): Array<{ labels: Labels; value: number }> {
    return [...(this.#families.get(name)?.samples.values() ?? [])].map((s) => ({
      labels: { ...s.labels },
      value: s.value,
    }));
  }

  /** The text exposition format, version 0.0.4. */
  async render(): Promise<string> {
    const lines: string[] = [];
    for (const f of [...this.#families.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      let samples = [...f.samples.values()];
      if (f.collect) {
        try {
          samples = await f.collect();
        } catch {
          continue;
        }
      }
      lines.push(`# HELP ${f.name} ${f.help}`, `# TYPE ${f.name} ${f.type}`);
      for (const s of samples) lines.push(`${f.name}${labelText(s.labels)} ${Number(s.value)}`);
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
  }
}

/** The cost drivers of 06 §10 that BE-085 names, as counter names. */
export const DRIVERS = {
  commits: 'docedit_tenant_commits_total',
  payloadBytes: 'docedit_tenant_payload_bytes_total',
  checkpoints: 'docedit_tenant_checkpoints_total',
  checkpointBytes: 'docedit_tenant_checkpoint_bytes_total',
  previewCompiles: 'docedit_tenant_preview_compiles_total',
  finalCompiles: 'docedit_tenant_final_compiles_total',
  compileSeconds: 'docedit_tenant_compile_seconds_total',
  storedBytes: 'docedit_tenant_stored_bytes_total',
} as const;

const HELP: Readonly<Record<string, string>> = {
  [DRIVERS.commits]: 'Commits stored, per tenant (BE-085).',
  [DRIVERS.payloadBytes]: 'UTF-8 bytes of the step payloads stored, per tenant (BE-085).',
  [DRIVERS.checkpoints]: 'Checkpoints written, per tenant (BE-085).',
  [DRIVERS.checkpointBytes]: 'Bytes of the checkpoints written, compressed, per tenant (BE-085).',
  [DRIVERS.previewCompiles]: 'Preview compiles that ran, per tenant (BE-085).',
  [DRIVERS.finalCompiles]: 'Requested export compiles that ran, per tenant (BE-085).',
  [DRIVERS.compileSeconds]: 'Seconds compile jobs ran, per tenant and kind (BE-085).',
  [DRIVERS.storedBytes]: 'Bytes stored in object storage, per tenant and kind (BE-085).',
};

export class TenantMeter {
  readonly metrics: Metrics;

  constructor(metrics: Metrics) {
    this.metrics = metrics;
  }

  add(tenant: string, counter: string, n: number, labels: Labels = {}): void {
    if (!(n > 0)) return;
    this.metrics.inc(counter, HELP[counter] ?? counter, { tenant, ...labels }, n);
  }

  /** A tenant's counters (for quotas, BE-091 and BE-092, and usage figures, UX-076). */
  read(tenant: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const counter of Object.values(DRIVERS))
      for (const s of this.metrics.samples(counter)) {
        if (s.labels['tenant'] !== tenant) continue;
        const extra = Object.entries(s.labels)
          .filter(([k]) => k !== 'tenant' && k !== 'node')
          .map(([k, v]) => `${k}=${v}`)
          .join(',');
        const key = extra ? `${counter}{${extra}}` : counter;
        out[key] = (out[key] ?? 0) + s.value;
      }
    return out;
  }
}

const utf8Length = (s: string) => Buffer.byteLength(s, 'utf8');

/**
 * A log store that meters the commits and step payload bytes of every stored write. It is a proxy,
 * so every other member of the concrete store (ownership, read helpers) works as before.
 */
export function meteredLogs<T extends LogStore>(inner: T, meter: TenantMeter): T {
  const append = async (
    ref: DocRef,
    req: WriteRequest,
    options?: AppendOptions,
  ): Promise<WriteResult> => {
    const r = await inner.append(ref, req, options);
    if (r.status === 'ok') {
      meter.add(ref.tenant, DRIVERS.commits, req.commits.length);
      let bytes = 0;
      for (const c of req.commits as ReadonlyArray<{ steps?: unknown }>)
        bytes += utf8Length(JSON.stringify(c.steps ?? []));
      meter.add(ref.tenant, DRIVERS.payloadBytes, bytes);
    }
    return r;
  };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'append') return append;
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** A checkpoint store that meters the checkpoints written and their bytes. */
export function meteredCheckpoints(
  inner: CheckpointStore & Required<Pick<CheckpointStore, 'putEncoded'>>,
  meter: TenantMeter,
  encode: (content: JsonEnvelope) => Uint8Array,
): CheckpointStore {
  const record = (ref: DocRef, bytes: number) => {
    meter.add(ref.tenant, DRIVERS.checkpoints, 1);
    meter.add(ref.tenant, DRIVERS.checkpointBytes, bytes);
    meter.add(ref.tenant, DRIVERS.storedBytes, bytes, { kind: 'checkpoint' });
  };
  const out: CheckpointStore = {
    async put(ref, seq, content) {
      const bytes = encode(content);
      await inner.putEncoded(ref, seq, bytes);
      record(ref, bytes.length);
    },
    async putEncoded(ref, seq, bytes) {
      await inner.putEncoded(ref, seq, bytes);
      record(ref, bytes.length);
    },
    get: (ref, seq) => inner.get(ref, seq),
    latest: (ref, seq) => inner.latest(ref, seq),
  };
  if (inner.getEncoded) out.getEncoded = (ref, seq) => inner.getEncoded!(ref, seq);
  if (inner.setAside) out.setAside = (ref, above) => inner.setAside!(ref, above);
  return out;
}
