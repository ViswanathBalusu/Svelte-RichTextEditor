/**
 * SEC-044 criterion 5, run through the purge job: "given a legal hold on the document, when the
 * retention period ends, then the evidence is kept until the hold ends". The job
 * (packages/authority/src/workflow/evidence-purge-job.ts) calls `planPurge` and deletes only the rows
 * the plan names. The store and the audit sink here are in-memory fakes of the interfaces the job
 * takes; the workflow tables are not built, so the job is not run against a stored log.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  runEvidencePurge,
  type EvidenceRowStore,
  type PurgeAuditSink,
} from '../../../packages/authority/src/workflow/evidence-purge-job.ts';
import type {
  EvidenceRow,
  PurgeAudit,
} from '../../../packages/authority/src/workflow/retention.ts';

const DOC = 'doc-1';
const RETENTION_MS = 1000;

class MemoryEvidence implements EvidenceRowStore {
  readonly rows = new Map<string, EvidenceRow[]>();
  readonly deletes: string[][] = [];

  constructor(initial: readonly EvidenceRow[]) {
    this.rows.set(DOC, [...initial]);
  }

  async listRows(documentId: string): Promise<readonly EvidenceRow[]> {
    return [...(this.rows.get(documentId) ?? [])];
  }

  async deleteRows(documentId: string, ids: readonly string[]): Promise<void> {
    this.deletes.push([...ids]);
    const gone = new Set(ids);
    this.rows.set(
      documentId,
      (this.rows.get(documentId) ?? []).filter((r) => !gone.has(r.id)),
    );
  }

  ids(): string[] {
    return (this.rows.get(DOC) ?? []).map((r) => r.id);
  }
}

class MemoryAudit implements PurgeAuditSink {
  readonly entries: { documentId: string; audit: PurgeAudit }[] = [];

  async record(documentId: string, audit: PurgeAudit): Promise<void> {
    this.entries.push({ documentId, audit });
  }
}

const rows: EvidenceRow[] = [
  { id: 'row-a', collectedAtMs: 0 },
  { id: 'row-b', collectedAtMs: 4000 },
];

describe('SEC-044 criterion 5: the purge job keeps evidence under a legal hold', () => {
  it('under a hold past the retention period, the job deletes nothing and audits no removal', async () => {
    const store = new MemoryEvidence(rows);
    const sink = new MemoryAudit();
    const result = await runEvidencePurge(store, sink, {
      documentId: DOC,
      nowMs: 5000,
      retentionMs: RETENTION_MS,
      legalHold: true,
    });
    expect(store.deletes).toEqual([]);
    expect(store.ids()).toEqual(['row-a', 'row-b']);
    expect(result.removed).toEqual([]);
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]!.audit).toEqual({
      kind: 'evidence.purge',
      atMs: 5000,
      removedCount: 0,
      keptCount: 2,
      legalHold: true,
    });
  });

  it('the evidence stays until the hold ends, then the next run removes the expired rows', async () => {
    const store = new MemoryEvidence(rows);
    const sink = new MemoryAudit();
    await runEvidencePurge(store, sink, {
      documentId: DOC,
      nowMs: 5000,
      retentionMs: RETENTION_MS,
      legalHold: true,
    });
    expect(store.ids()).toEqual(['row-a', 'row-b']);
    const after = await runEvidencePurge(store, sink, {
      documentId: DOC,
      nowMs: 5000,
      retentionMs: RETENTION_MS,
      legalHold: false,
    });
    expect(after.removed).toEqual(['row-a', 'row-b']);
    expect(store.ids()).toEqual([]);
    expect(sink.entries.map((e) => e.audit.removedCount)).toEqual([0, 2]);
  });

  it('the audit entry names no row, only counts and the instant', async () => {
    const store = new MemoryEvidence(rows);
    const sink = new MemoryAudit();
    await runEvidencePurge(store, sink, {
      documentId: DOC,
      nowMs: 5000,
      retentionMs: RETENTION_MS,
      legalHold: false,
    });
    const text = JSON.stringify(sink.entries);
    expect(text).not.toContain('row-a');
    expect(text).not.toContain('row-b');
  });

  it('for any rows, retention and instant: under a hold nothing is deleted; without it exactly the expired rows go, and the store keeps the rest', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 20 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.boolean(),
        async (collected, retentionMs, extra, legalHold) => {
          const initial = collected.map((c, i) => ({ id: `r${i}`, collectedAtMs: c }));
          const nowMs = (collected.length ? Math.max(...collected) : 0) + extra;
          const store = new MemoryEvidence(initial);
          const sink = new MemoryAudit();
          const result = await runEvidencePurge(store, sink, {
            documentId: DOC,
            nowMs,
            retentionMs,
            legalHold,
          });
          if (legalHold) {
            expect(store.deletes).toEqual([]);
            expect(store.ids()).toEqual(initial.map((r) => r.id));
          } else {
            const expired = initial
              .filter((r) => nowMs - r.collectedAtMs >= retentionMs)
              .map((r) => r.id);
            expect(result.removed).toEqual(expired);
            expect(store.ids()).toEqual(
              initial.filter((r) => nowMs - r.collectedAtMs < retentionMs).map((r) => r.id),
            );
          }
          expect(sink.entries[0]!.audit.removedCount).toBe(result.removed.length);
          expect(result.removed.length + result.kept.length).toBe(initial.length);
        },
      ),
      { numRuns: 300 },
    );
  });
});
