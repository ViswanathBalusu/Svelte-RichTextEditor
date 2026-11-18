/**
 * Delivery of the outbox (06 §3 second bullet; 04 §10; BE-039, BE-023). The node claims pending
 * items, applies each in the room that owns the document or in a transient authority, and settles
 * it: done with the stored `seq`, or failed with the room's rejection, which the requester can read
 * back. An item the room could not take now (`unavailable`) is given back and tried again later.
 * Delivery is at least once; the item's deterministic commit identifier makes the effect exactly
 * once (the room's step 2, and the log's unique key on the commit identifier).
 */
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import type { JsonEnvelope } from '@docedit/model';
import { decodeContent } from '../storage/codec.ts';
import type { OutboxItem, OutboxStore } from '../storage/types.ts';
import type { Metrics } from './metrics.ts';
import type { RoomHost, ServerOp } from './room-host.ts';
import type { Settings } from './settings.ts';
import { parseTraceparent, type Tracer } from './tracing.ts';
import { DataPlaneError, RequestRefused } from './wire.ts';

export type Outcome =
  | { state: 'done'; seq: number }
  | {
      state: 'failed';
      code: string;
      syncCode?: string;
      action?: string;
      message: string;
      /** False while the item stays pending for another attempt. */
      final?: boolean;
    };

/** The outcome a settled item records. */
export function outcomeOf(item: OutboxItem): Outcome {
  const r = item.result ?? {};
  if (item.state === 'done' && typeof r['seq'] === 'number')
    return { state: 'done', seq: r['seq'] };
  return {
    state: 'failed',
    code: typeof r['code'] === 'string' ? r['code'] : 'internal',
    ...(typeof r['syncCode'] === 'string' ? { syncCode: r['syncCode'] } : {}),
    ...(typeof r['action'] === 'string' ? { action: r['action'] } : {}),
    message: typeof r['message'] === 'string' ? r['message'] : 'the operation failed',
  };
}

/** The operation an outbox item asks for, decoded; null when the item is malformed. */
export function opOf(item: OutboxItem): ServerOp | null {
  const r = item.request;
  const actor = typeof r['actor'] === 'string' ? r['actor'] : 'system';
  const preconditions =
    r['preconditions'] && typeof r['preconditions'] === 'object'
      ? (r['preconditions'] as NonNullable<Extract<ServerOp, { kind: 'author' }>['preconditions']>)
      : undefined;
  const trace = parseTraceparent(r['traceparent']);
  if (item.kind === 'snapshot') {
    if (!item.payload) return null;
    const text = zstdDecompressSync(item.payload);
    const reason = r['reason'];
    if (
      reason !== 'import' &&
      reason !== 'restore' &&
      reason !== 'migration' &&
      reason !== 'repair'
    )
      return null;
    return {
      kind: 'snapshot',
      id: item.commitId,
      reason,
      actor,
      content: {
        envelope: decodeContent<JsonEnvelope>(item.payload),
        encoded: item.payload,
        hash: createHash('sha256').update(text).digest('hex'),
        bytes: text.length,
      },
      ...(preconditions ? { preconditions } : {}),
      trace,
    };
  }
  // An evidence anchor (FRW-041): an `author` item with no steps, holding the origin and the salted
  // hash. The outbox needs no new kind for it.
  const anchored = r['evidence'];
  if (anchored !== undefined) {
    const ev = anchored as { origin?: unknown; evidenceHash?: unknown } | null;
    if (
      ev === null ||
      typeof ev !== 'object' ||
      (ev.origin !== 'sign' && ev.origin !== 'rules' && ev.origin !== 'decline') ||
      typeof ev.evidenceHash !== 'string'
    )
      return null;
    return {
      kind: 'anchor',
      id: item.commitId,
      actor: 'system',
      evidence: { origin: ev.origin, evidenceHash: ev.evidenceHash },
      trace,
    };
  }
  if (typeof r['origin'] !== 'string' || !Number.isSafeInteger(r['base'])) return null;
  return {
    kind: 'author',
    id: item.commitId,
    origin: r['origin'],
    actor,
    base: r['base'] as number,
    steps: r['steps'],
    ...(preconditions ? { preconditions } : {}),
    trace,
  };
}

export class OutboxDelivery {
  readonly #store: OutboxStore;
  readonly #host: RoomHost;
  readonly #node: string;
  readonly #settings: Settings;
  readonly #metrics: Metrics;
  readonly #tracer: Tracer;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #polling: Promise<void> | null = null;
  #stopped = false;
  #again = false;
  /** Items being delivered by this node, so that the poll does not take them twice. */
  readonly #busy = new Map<string, Promise<Outcome>>();
  /** Requests waiting for the outcome of an item. */
  readonly #waiters = new Map<string, Array<(o: Outcome) => void>>();
  readonly stats = { delivered: 0, failed: 0, retried: 0 };

  constructor(deps: {
    store: OutboxStore;
    host: RoomHost;
    node: string;
    settings: Settings;
    metrics: Metrics;
    tracer: Tracer;
  }) {
    this.#store = deps.store;
    this.#host = deps.host;
    this.#node = deps.node;
    this.#settings = deps.settings;
    this.#metrics = deps.metrics;
    this.#tracer = deps.tracer;
  }

  start(): void {
    this.#arm(0);
  }

  #arm(ms: number): void {
    if (this.#stopped || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.poll();
    }, ms);
    this.#timer.unref?.();
  }

  /** Claims and delivers what is pending; then waits for the next poll. */
  poll(): Promise<void> {
    if (this.#polling) {
      this.#again = true;
      return this.#polling;
    }
    this.#polling = (async () => {
      try {
        const o = this.#settings.outbox;
        const items = await this.#store.claim(this.#node, o.leaseMs, o.batch);
        await Promise.all(items.filter((i) => !this.#busy.has(i.id)).map((i) => this.deliver(i)));
      } catch (e) {
        this.#settings.onError(e, 'outbox');
      } finally {
        this.#polling = null;
        const again = this.#again;
        this.#again = false;
        this.#arm(again ? 0 : this.#settings.outbox.pollMs);
      }
    })();
    return this.#polling;
  }

  /**
   * The outcome of an item, once some node has settled it (the request path of `PUT …/content`):
   * this node polls at once; an item another node claimed is read back until it is settled.
   * Resolves with `unavailable` after `timeoutMs`.
   */
  async outcome(item: OutboxItem, timeoutMs: number): Promise<Outcome> {
    const mine = new Promise<Outcome>((resolve) => {
      const list = this.#waiters.get(item.id) ?? [];
      list.push(resolve);
      this.#waiters.set(item.id, list);
    });
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    void this.poll();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tick = new Promise<null>((r) =>
        setTimeout(() => r(null), Math.min(this.#settings.outbox.pollMs, 250)).unref?.(),
      );
      const got = await Promise.race([mine, tick]);
      if (got) return got;
      const stored = await this.#store.get(item.tenant, item.id).catch(() => null);
      if (stored && stored.state !== 'pending') return outcomeOf(stored);
      if (Date.now() > deadline || this.#stopped)
        return { state: 'failed', code: 'unavailable', message: 'the operation is still pending' };
    }
  }

  /** Applies one claimed item and settles it. */
  deliver(item: OutboxItem): Promise<Outcome> {
    const known = this.#busy.get(item.id);
    if (known) return known;
    const p = this.#deliver(item).finally(() => this.#busy.delete(item.id));
    this.#busy.set(item.id, p);
    void p.then((out) => {
      if (out.state === 'failed' && out.final === false) return;
      for (const w of this.#waiters.get(item.id) ?? []) w(out);
      this.#waiters.delete(item.id);
    });
    return p;
  }
  async #deliver(item: OutboxItem): Promise<Outcome> {
    const op = opOf(item);
    const ref = { tenant: item.tenant, doc: item.doc };
    const span = this.#tracer.start('dep.outbox', op?.trace ?? null, {
      tenant: item.tenant,
      doc: item.doc,
      item: item.id,
      kind: item.kind,
    });
    if (!op) {
      const out: Outcome = {
        state: 'failed',
        code: 'validation_failed',
        message: 'malformed item',
      };
      await this.#settle(item, out);
      span.end({ outcome: 'failed' });
      return out;
    }
    try {
      const { seq } = await this.#host.apply(ref, {
        ...op,
        trace: { traceId: span.traceId, spanId: span.spanId },
      });
      const out: Outcome = { state: 'done', seq };
      await this.#settle(item, out);
      span.end({ outcome: 'done', seq });
      return out;
    } catch (e) {
      const retry =
        !(e instanceof DataPlaneError) ||
        e.code === 'unavailable' ||
        e.code === 'rate_limited' ||
        (e instanceof RequestRefused && e.rejection.action === 'retry');
      if (retry) {
        // The room could not take it now: another attempt later, by this node or another.
        this.stats.retried++;
        await this.#store.unlock(item, this.#node).catch(() => undefined);
        span.end({ outcome: 'retry' });
        if (!(e instanceof DataPlaneError))
          this.#settings.onError(e, `outbox ${item.id}`, { tenant: item.tenant, doc: item.doc });
        return {
          state: 'failed',
          code: 'unavailable',
          message: e instanceof Error ? e.message : 'unavailable',
          final: false,
        };
      }
      const out: Outcome =
        e instanceof RequestRefused
          ? {
              state: 'failed',
              code: e.code,
              syncCode: e.rejection.code,
              action: e.rejection.action,
              message: e.rejection.reason,
            }
          : { state: 'failed', code: e.code, message: e.message };
      await this.#settle(item, out);
      span.end({ outcome: 'failed', code: out.code });
      return out;
    }
  }

  async #settle(item: OutboxItem, out: Outcome): Promise<void> {
    const { state, ...result } = out;
    if (state === 'done') this.stats.delivered++;
    else this.stats.failed++;
    this.#metrics.outbox.inc({ tenant: item.tenant, state });
    try {
      await this.#store.settle(item, this.#node, state, result);
    } catch (e) {
      this.#settings.onError(e, `outbox ${item.id}`, { tenant: item.tenant, doc: item.doc });
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#polling?.catch(() => undefined);
    await Promise.allSettled([...this.#busy.values()]);
  }
}
