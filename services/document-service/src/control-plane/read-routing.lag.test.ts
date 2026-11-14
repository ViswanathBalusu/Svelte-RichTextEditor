// Replica lag reported when metrics are scraped (BE-064 criterion 4). The replica port is in memory:
// a replica that lags by a set amount per document. No PostgreSQL standby was run (no database).
import { describe, expect, it } from 'vitest';
import { Metrics } from './metrics.ts';
import { ReadRouter, type ReplicaPort } from './read-routing.ts';

/** A replica that lags the primary by a set number of sequence numbers for each document. */
function laggingReplica(
  primaryHead: Map<string, number>,
  lag: Map<string, number>,
): ReplicaPort<object> {
  const key = (t: string, d: string) => JSON.stringify([t, d]);
  return {
    store: {},
    async appliedSeq(t, d) {
      const head = primaryHead.get(key(t, d));
      return head === undefined ? null : Math.max(0, head - (lag.get(key(t, d)) ?? 0));
    },
    async primarySeq(t, d) {
      return primaryHead.get(key(t, d)) ?? null;
    },
  };
}

const LAG_LINE = /^docedit_replica_lag_seq\{tenant="([^"]+)"\} (\S+)$/gm;

function lagByTenant(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of text.matchAll(LAG_LINE)) out[m[1] ?? ''] = Number(m[2]);
  return out;
}

describe('replica lag is reported when metrics are scraped (BE-064 criterion 4)', () => {
  it('samples the lag of a document read on the replica again at each scrape', async () => {
    const heads = new Map([[JSON.stringify(['t-a', 'doc-1']), 10]]);
    const lag = new Map([[JSON.stringify(['t-a', 'doc-1']), 3]]);
    const metrics = new Metrics();
    const router = new ReadRouter({
      primary: {},
      replica: laggingReplica(heads, lag),
      metrics,
      lagDocuments: 8,
    });
    // A read of the document, on the replica (the pinned sequence is applied).
    await router.read({ kind: 'pinned', tenant: 't-a', doc: 'doc-1', seq: 5 }, async () => 'body');

    expect(lagByTenant(await metrics.render())).toEqual({ 't-a': 3 });

    // The replica catches up after the read; the next scrape reports the new lag, with no
    // observeLag call from the composition.
    lag.set(JSON.stringify(['t-a', 'doc-1']), 1);
    expect(lagByTenant(await metrics.render())).toEqual({ 't-a': 1 });
  });

  it('reports the largest lag per tenant over the documents remembered', async () => {
    const heads = new Map([
      [JSON.stringify(['t-a', 'doc-1']), 10],
      [JSON.stringify(['t-a', 'doc-2']), 20],
    ]);
    const lag = new Map([
      [JSON.stringify(['t-a', 'doc-1']), 2],
      [JSON.stringify(['t-a', 'doc-2']), 7],
    ]);
    const metrics = new Metrics();
    const router = new ReadRouter({
      primary: {},
      replica: laggingReplica(heads, lag),
      metrics,
      lagDocuments: 8,
    });
    await router.read({ kind: 'pinned', tenant: 't-a', doc: 'doc-1', seq: 1 }, async () => 'a');
    await router.read({ kind: 'pinned', tenant: 't-a', doc: 'doc-2', seq: 1 }, async () => 'b');

    expect(lagByTenant(await metrics.render())).toEqual({ 't-a': 7 });
  });

  it('forgets the least recent document beyond the limit, so its lag is no longer sampled', async () => {
    const heads = new Map([
      [JSON.stringify(['t-a', 'doc-1']), 10],
      [JSON.stringify(['t-a', 'doc-2']), 10],
    ]);
    const lag = new Map([
      [JSON.stringify(['t-a', 'doc-1']), 4],
      [JSON.stringify(['t-a', 'doc-2']), 1],
    ]);
    const metrics = new Metrics();
    const router = new ReadRouter({
      primary: {},
      replica: laggingReplica(heads, lag),
      metrics,
      lagDocuments: 1,
    });
    await router.read({ kind: 'pinned', tenant: 't-a', doc: 'doc-1', seq: 1 }, async () => 'a');
    await router.read({ kind: 'pinned', tenant: 't-a', doc: 'doc-2', seq: 1 }, async () => 'b');

    // Only doc-2 is sampled at the scrape; doc-1's earlier sample is dropped with it.
    expect(lagByTenant(await metrics.render())).toEqual({ 't-a': 1 });
  });

  it('samples nothing at a scrape when no limit is set', async () => {
    const heads = new Map([[JSON.stringify(['t-a', 'doc-1']), 10]]);
    const lag = new Map([[JSON.stringify(['t-a', 'doc-1']), 3]]);
    const metrics = new Metrics();
    const router = new ReadRouter({ primary: {}, replica: laggingReplica(heads, lag), metrics });
    await router.read({ kind: 'pinned', tenant: 't-a', doc: 'doc-1', seq: 1 }, async () => 'a');

    expect(lagByTenant(await metrics.render())).toEqual({});
  });
});
