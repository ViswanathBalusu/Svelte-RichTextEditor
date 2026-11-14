// Exports and previews are compiled from the requester's projection (BE-098 criterion 1; ADR 0019;
// 09 §9.1; EXP-123). A reader from whom a region is hidden gets a job whose payload names the
// hidden region and the reader's view token; the owner gets the whole document. Runs over real HTTP
// against the in-process service with in-memory storage and with PostgreSQL (lane U-BE-085-098).
import { NOTHING_HIDDEN, type Visibility } from '@docedit/authority';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const LEGAL = 'rLegal0000000001';

/** The legal region is hidden from everyone but owners (the policy shape of be-098-field-projection). */
const visibility: Visibility = (conn) =>
  conn.role === 'owner'
    ? NOTHING_HIDDEN
    : { regions: new Set([LEGAL]), values: new Set(), titles: false };

/** Waits until `count()` reaches `n`, or fails after a bounded wait. */
async function waitFor(count: () => number, n: number): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (count() >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${n} jobs, saw ${count()}`);
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`exports and previews are the requester projection (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const seen: Array<{ doc: string; payload: Record<string, unknown> }> = [];
    /** The compile stand-in records the payload and finishes at once; it writes no files. */
    const exportHandler: JobHandler = async (job) => {
      seen.push({ doc: job.doc!, payload: job.payload });
      return {
        output: 'output.pdf',
        pages: 1,
        layout: null,
        converged: true,
        log: null,
        diagnostics: [],
      } as unknown as Record<string, unknown>;
    };

    beforeAll(async () => {
      if (!skip)
        h = await startHarness(storage, {
          views: { ...FULL_VIEWS, visibility },
          jobHandlers: { export: exportHandler },
          config: { jobIdleMs: 20, jobLeaseMs: 2000 },
        });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'compiles an export for a reader with the hidden region named in the job, and the owner with none (BE-098 criterion 1)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const reader = h.userToken({ [doc]: 'editor' });
        const owner = h.userToken({ [doc]: 'owner' });
        const before = seen.length;
        const asReader = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: reader,
          body: { target: 'pdf', options: { profile: 'final' } },
        });
        expect(asReader.status).toBe(202);
        const asOwner = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: owner,
          body: { target: 'pdf', options: { profile: 'final' } },
        });
        expect(asOwner.status).toBe(202);
        await waitFor(() => seen.length - before, 2);
        const mine = seen.slice(before).filter((s) => s.doc === doc);
        const readerJob = mine.find((s) => s.payload['role'] === 'editor')!;
        const ownerJob = mine.find((s) => s.payload['role'] === 'owner')!;
        expect(readerJob.payload['hiddenRegions']).toEqual([LEGAL]);
        expect(ownerJob.payload['hiddenRegions']).toEqual([]);
        expect(readerJob.payload['view']).toBeTypeOf('string');
        expect(readerJob.payload['view']).not.toBe(ownerJob.payload['view']);
      },
    );

    it.skipIf(skip)(
      'compiles a preview for a reader with the hidden region named in the job (BE-098 criterion 1; BE-051)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const reader = h.userToken({ [doc]: 'editor' });
        const before = seen.length;
        const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: reader,
          body: { target: 'pdf', options: { profile: 'preview' } },
        });
        expect(r.status).toBe(202);
        await waitFor(() => seen.length - before, 1);
        const job = seen.slice(before).find((s) => s.doc === doc)!;
        expect(job.payload).toMatchObject({ profile: 'preview', role: 'editor' });
        expect(job.payload['hiddenRegions']).toEqual([LEGAL]);
        expect(job.payload['view']).toBeTypeOf('string');
      },
    );
  });
}
