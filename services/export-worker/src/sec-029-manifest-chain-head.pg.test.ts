/**
 * SEC-029 criterion 4, the export half (10 §3.3 "forging history"; 08 §12): an export manifest
 * carries the chain head of the exported state, read from the stored log.
 *
 * The log is real: PostgreSQL (the shared `docedit-test-postgres` container; each run makes its own
 * database and drops it), written through `PgLogStore.append`, which computes the hash chain. The
 * export runs through the real handler and JobRunner with the stores the worker's `main.ts` gives
 * it: the log store, the document store and `chainHeadAt` of the log store. The compile is a fake
 * and the content comes from a stand-in checkpoint store, since the commits here are the contract
 * suite's and carry no document steps; the chain does not depend on either.
 *
 * Each expected value is read from the `doc_commits` table by the schema owner, not through the
 * store. Skips when PostgreSQL is not up (infra/test-env.ps1 up).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  JobRunner,
  MemoryJobQueue,
  type DocRef,
  type JobQueue,
  type JobRecord,
  type PgLogStore,
} from '@docedit/document-service';
import {
  controlCommit,
  newDocument,
  stepCommit,
  write,
  type StoreHarness,
} from '../../document-service/test/contract/checks.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../../document-service/test/support/env.ts';
import { demoDocument } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler } from './job.ts';
import { LIMITS, type CompileResult, type SandboxOptions } from './sandbox.ts';

const skip = await postgresUnavailable();
if (skip) console.warn(`skipped: ${skip}`);

const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

const parse = (text: string | Uint8Array | undefined): Record<string, unknown> | null =>
  text === undefined
    ? null
    : (JSON.parse(typeof text === 'string' ? text : new TextDecoder().decode(text)) as Record<
        string,
        unknown
      >);

describe.skipIf(skip !== null)(
  'SEC-029 criterion 4: the export manifest carries the chain head of the stored log (PostgreSQL)',
  () => {
    let db: TestDatabase;
    let h: StoreHarness;

    beforeAll(async () => {
      db = await createTestDatabase();
      const s = pgStores(db.service);
      h = {
        tenant: newTenant(),
        otherTenant: newTenant(),
        docs: s.docs,
        logs: s.logs,
        grants: s.grants,
      };
    });
    afterAll(() => db?.drop());

    /** The stored hash of the commit at `seq`, read by the schema owner. */
    const storedHash = async (ref: DocRef, seq: number): Promise<string> => {
      const r = await db.admin.query<{ hash: string }>(
        "SELECT encode(hash, 'hex') AS hash FROM doc_commits WHERE doc_id = $1 AND seq = $2",
        [ref.doc, seq],
      );
      expect(r.rows).toHaveLength(1);
      return r.rows[0]!.hash;
    };

    /** Runs one export of `ref` at `seq` through the real handler; returns its manifests. */
    async function exportAt(ref: DocRef, seq: number) {
      const logs = h.logs as PgLogStore;
      const envelope = demoDocument().envelope;
      const stores: ContentStores = {
        logs,
        // A checkpoint at every seq: the commits of the contract suite carry no document steps.
        checkpoints: {
          latest: async (_ref, at: number) => ({ seq: at, content: envelope }) as never,
          get: async () => null,
        },
        documents: h.docs,
        chainHeadAt: (r, s) => logs.chainHeadAt(r, s),
      };
      const bundleManifests: string[] = [];
      const compile = async (
        files: Readonly<Record<string, string | Uint8Array>>,
        opts: SandboxOptions,
      ): Promise<CompileResult> => {
        const bm = files['manifest.json'];
        bundleManifests.push(
          typeof bm === 'string' ? bm : new TextDecoder().decode(bm ?? new Uint8Array()),
        );
        const n = opts.maxPasses ?? 2;
        return {
          ok: true,
          exitCode: 0,
          timedOut: false,
          outputOverflow: false,
          cancelled: false,
          passes: Array.from({ length: n }, (_, i) => ({ pass: i + 1, rc: 0, ms: 100 })),
          converged: n > 1,
          pdf: new TextEncoder().encode('%PDF-2.0 test'),
          log: 'This is LuaHBTeX\n',
          layoutRaw: RAW_LAYOUT,
          stderr: '',
          wallMs: 1500,
          stdout: new Uint8Array(),
          name: 'docedit-sec029-w3',
          limits: { ...LIMITS },
          passTimeoutSeconds: 110,
        };
      };
      const stored = new Map<string, Uint8Array>();
      const handler = createExportHandler({
        stores,
        outputs: {
          putExport: async (_tenant: string, _job: string, name: string, bytes: Uint8Array) => {
            stored.set(name, bytes);
          },
        } as never,
        fonts: async () => TEST_FONTS,
        imageId: async () => `sha256:${'d'.repeat(64)}`,
        compile,
      });
      const queue: JobQueue = new MemoryJobQueue();
      const runner = new JobRunner({
        queue,
        handlers: { export: handler },
        worker: 'w-sec029-w3',
        leaseMs: 60_000,
        idleMs: 10,
        retryAfterMs: 0,
      });
      const job = await queue.enqueue(ref.tenant, {
        kind: 'export',
        doc: ref.doc,
        createdBy: 'user-1',
        payload: {
          doc: ref.doc,
          target: 'pdf',
          seq,
          incarnation: (await logs.head(ref)).incarnation,
          options: { fields: 'flatten' },
          requester: 'user-1',
          role: 'editor',
          view: 'v',
          hiddenRegions: [],
          hiddenValues: [],
        },
      });
      await runner.runOnce();
      const done = (await queue.get(ref.tenant, job.id)) as JobRecord;
      expect(done.state, JSON.stringify(done.error ?? null)).toBe('completed');
      return {
        bundle: parse(bundleManifests[0]),
        result: parse(stored.get('manifest.json')),
        job: done.result as { chainHead?: unknown },
      };
    }

    it('names the stored hash of the head, follows a new commit, and names an older state by its own hash', async () => {
      const { ref, epoch } = await newDocument(h);
      const logs = h.logs as PgLogStore;
      expect(await logs.append(ref, write(epoch, [stepCommit(1), stepCommit(2)]))).toEqual({
        status: 'ok',
      });

      const at2 = await storedHash(ref, 2);
      const first = await exportAt(ref, 2);
      expect(first.bundle?.['seq']).toBe(2);
      expect(first.bundle?.['chainHead']).toBe(at2);
      expect(first.result?.['chainHead']).toBe(at2);
      expect(first.job.chainHead).toBe(at2);
      expect((await logs.state(ref)).chainHead).toBe(at2);

      // The document changes: a content commit and a control commit. A new export names the new
      // head, and an export of the older state still names the hash of that state.
      expect(await logs.append(ref, write(epoch, [stepCommit(3)]))).toEqual({ status: 'ok' });
      expect(await logs.append(ref, write(epoch, [controlCommit(4, 1)]))).toEqual({
        status: 'ok',
      });
      const at4 = await storedHash(ref, 4);
      expect(at4).not.toBe(at2);
      const second = await exportAt(ref, 4);
      expect(second.bundle?.['seq']).toBe(4);
      expect(second.bundle?.['chainHead']).toBe(at4);
      expect(second.result?.['chainHead']).toBe(at4);
      expect((await logs.state(ref)).chainHead).toBe(at4);

      const older = await exportAt(ref, 2);
      expect(older.bundle?.['chainHead']).toBe(at2);
      expect(older.result?.['chainHead']).toBe(at2);

      // The chain the manifests name is the one the verifier accepts.
      expect(await logs.verify(ref)).toEqual({ ok: true, head: 4 });
    }, 60_000);
  },
);
