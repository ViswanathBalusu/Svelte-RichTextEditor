// The storage contract against the in-memory store, and against a store without a conditional
// append, which the suite must refuse (BE-002). No database needed.
import type { StoredCommit, WriteRequest, WriteResult } from '@docedit/authority';
import { describe, expect, it } from 'vitest';
import {
  MemoryStore,
  type DocRef,
  type LogHead,
  type LogStore,
  type OwnershipStore,
} from '../../src/index.ts';
import { newTenant } from '../support/env.ts';
import {
  GRANT_STORE_CHECKS,
  LOG_STORE_CHECKS,
  failingChecks,
  type StoreHarness,
} from './checks.ts';

function memoryHarness(): StoreHarness {
  const store = new MemoryStore();
  return { tenant: newTenant(), otherTenant: newTenant(), docs: store, logs: store, grants: store };
}

describe('storage contract: in-memory store', () => {
  for (const c of [...LOG_STORE_CHECKS, ...GRANT_STORE_CHECKS])
    it(c.name, () => c.run(memoryHarness()));
});

/** Appends whatever it is given: no epoch, head or revision condition. */
class UnconditionalLog implements LogStore, OwnershipStore {
  readonly #inner: MemoryStore;
  readonly #logs = new Map<string, StoredCommit[]>();

  constructor(inner: MemoryStore) {
    this.#inner = inner;
  }

  async append(ref: DocRef, req: WriteRequest): Promise<WriteResult> {
    const log = this.#logs.get(ref.doc) ?? [];
    for (const c of req.commits)
      log[c.seq - 1] = structuredClone({ ...c, scopes: [...c.scopes].sort() });
    this.#logs.set(ref.doc, log);
    return { status: 'ok' };
  }

  async read(ref: DocRef, fromSeq = 1, toSeq?: number): Promise<StoredCommit[]> {
    return (this.#logs.get(ref.doc) ?? []).filter(
      (c) => c.seq >= fromSeq && (toSeq === undefined || c.seq <= toSeq),
    );
  }

  async head(ref: DocRef): Promise<LogHead> {
    return { ...(await this.#inner.head(ref)), seq: (this.#logs.get(ref.doc) ?? []).length };
  }

  claim(ref: DocRef, node: string): Promise<number> {
    return this.#inner.claim(ref, node);
  }

  release(ref: DocRef, node: string, epoch: number): Promise<boolean> {
    return this.#inner.release(ref, node, epoch);
  }
}

describe('storage contract: a log store without a conditional append', () => {
  it('fails the suite, so it cannot pass as a LogStore', async () => {
    const failed = await failingChecks(LOG_STORE_CHECKS, () => {
      const inner = new MemoryStore();
      return {
        tenant: newTenant(),
        otherTenant: newTenant(),
        docs: inner,
        logs: new UnconditionalLog(inner),
        grants: inner,
      };
    });
    const names = failed.map((f) => f.split(':')[0]);
    for (const required of [
      'an append with a stale ownership epoch is fenced and stores nothing',
      'an append that leaves a gap after the head is fenced and stores nothing',
      'an append for an existing (document, seq) is fenced and stores nothing',
      'an append checked against a replaced grants revision stores nothing and returns the permissions in force',
      'a batch is stored entirely or not at all',
    ])
      expect(names, failed.join('\n')).toContain(required);
  });
});
