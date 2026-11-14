// BE-054 criteria 1 and 3 on PostgreSQL (lane U-BE-043-056): the search tables of search-index-pg.ts
// and the indexer job of search-indexer.ts writing to them, against a database this test creates
// (docedit_u_be_043_056_<hex>) and drops afterwards. Tenants carry the lane name so that nothing
// else in the shared database is touched. Skips, with the reason, when PostgreSQL is not up
// (infra/test-env.ps1 up). Not shown here: the GET /search route (criterion 2), the purge pipeline
// that calls purgeDocument (criterion 3), and the call that queues a job after a checkpoint write
// (criterion 1); criterion 5 is not a database question.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import type { JobRecord } from '../../src/control-plane/jobs/queue.ts';
import type { JobContext } from '../../src/control-plane/jobs/runner.ts';
import { SearchIndex } from '../../src/control-plane/search-index.ts';
import {
  PgSearchIndex,
  SEARCH_INDEX_DDL,
  tokenCounts,
} from '../../src/control-plane/search-index-pg.ts';
import {
  createSearchIndexHandler,
  type CheckpointSource,
} from '../../src/control-plane/search-indexer.ts';
import { ADMIN, postgresUnavailable } from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const LANE = 'U-BE-043-056';
const TENANT_A = `t-${LANE}-a`;
const TENANT_B = `t-${LANE}-b`;

const paragraph = (text: string): JsonNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** A checkpoint source held in memory: the test chooses what each class may read. */
function checkpoints(): CheckpointSource & {
  put(tenant: string, doc: string, seq: number, visibility: string, content: JsonNode): void;
} {
  const held = new Map<string, JsonNode>();
  const k = (tenant: string, doc: string, seq: number, visibility: string) =>
    JSON.stringify([tenant, doc, seq, visibility]);
  return {
    put(tenant, doc, seq, visibility, content) {
      held.set(k(tenant, doc, seq, visibility), content);
    },
    async readCheckpoint(tenant, doc, seq, visibility) {
      return held.get(k(tenant, doc, seq, visibility)) ?? null;
    },
  };
}

/**
 * The indexer's handler with the job context a runner passes. The handler never reports progress
 * and is never cancelled here, so the context is inert.
 */
function indexer(
  deps: Parameters<typeof createSearchIndexHandler>[0],
): (job: JobRecord) => Promise<Record<string, unknown>> {
  const handler = createSearchIndexHandler(deps);
  const ctx: JobContext = { signal: new AbortController().signal, report: async () => 'ok' };
  return (job) => handler(job, ctx);
}

/** Runs the indexer job for one checkpoint, as the job runner would, for the job's tenant. */
function jobFor(tenant: string, doc: string, seq: number, visibility: string): JobRecord {
  return {
    tenant,
    doc,
    kind: 'search-index',
    payload: { doc, seq, visibility },
  } as unknown as JobRecord;
}

describe.skipIf(unavailable !== null)(
  'BE-054 on PostgreSQL: the search tables and the indexer',
  () => {
    const name = `docedit_u_be_043_056_${randomBytes(6).toString('hex')}`;
    let pool: pg.Pool;

    beforeAll(async () => {
      const root = new pg.Client(ADMIN);
      await root.connect();
      try {
        await root.query(`CREATE DATABASE ${name}`);
      } finally {
        await root.end();
      }
      pool = new pg.Pool({ ...ADMIN, database: name, max: 4 });
      await pool.query(SEARCH_INDEX_DDL);
    }, 120_000);

    afterAll(async () => {
      await pool?.end();
      const root = new pg.Client(ADMIN);
      await root.connect();
      try {
        await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await root.end();
      }
    }, 120_000);

    it('indexes a checkpoint through the job and finds it for its tenant only (criterion 1)', async () => {
      const src = checkpoints();
      const index = new PgSearchIndex(pool);
      const handler = indexer({ checkpoints: src, index });
      src.put(TENANT_A, 'doc-1', 3, 'full', paragraph('The quick brown fox. The fox sleeps.'));
      src.put(TENANT_B, 'doc-1', 3, 'full', paragraph('An unrelated fox in another tenant.'));

      const a = await handler(jobFor(TENANT_A, 'doc-1', 3, 'full'));
      expect(a).toEqual({ indexed: true, seq: 3 });
      await handler(jobFor(TENANT_B, 'doc-1', 3, 'full'));

      const hitsA = await index.search(TENANT_A, 'fox', { readable: 'all', limit: 10 });
      expect(hitsA).toEqual([{ doc: 'doc-1', seq: 3, score: 2 }]);
      const hitsB = await index.search(TENANT_B, 'fox', { readable: 'all', limit: 10 });
      expect(hitsB).toEqual([{ doc: 'doc-1', seq: 3, score: 1 }]);
      expect(await index.search(TENANT_A, 'unrelated', { readable: 'all', limit: 10 })).toEqual([]);
      expect(await index.size(TENANT_A)).toBe(1);
    });

    it('keeps the higher sequence and reports a lower one as not stored, atomically', async () => {
      const src = checkpoints();
      const index = new PgSearchIndex(pool);
      const handler = indexer({ checkpoints: src, index });
      src.put(TENANT_A, 'doc-seq', 5, 'full', paragraph('alpha beta'));
      src.put(TENANT_A, 'doc-seq', 4, 'full', paragraph('gamma'));
      src.put(TENANT_A, 'doc-seq', 6, 'full', paragraph('delta'));

      expect(await handler(jobFor(TENANT_A, 'doc-seq', 5, 'full'))).toEqual({
        indexed: true,
        seq: 5,
      });
      expect(await handler(jobFor(TENANT_A, 'doc-seq', 4, 'full'))).toEqual({
        indexed: false,
        seq: 4,
      });
      // The lower checkpoint did not replace the tokens of the higher one.
      expect(await index.search(TENANT_A, 'alpha', { readable: 'all', limit: 5 })).toEqual([
        { doc: 'doc-seq', seq: 5, score: 1 },
      ]);
      expect(await index.search(TENANT_A, 'gamma', { readable: 'all', limit: 5 })).toEqual([]);
      expect(await handler(jobFor(TENANT_A, 'doc-seq', 6, 'full'))).toEqual({
        indexed: true,
        seq: 6,
      });
      expect(await index.search(TENANT_A, 'delta', { readable: 'all', limit: 5 })).toEqual([
        { doc: 'doc-seq', seq: 6, score: 1 },
      ]);
      expect(await index.search(TENANT_A, 'alpha', { readable: 'all', limit: 5 })).toEqual([]);
    });

    it('answers only the classes the principal may read (ADR 0019)', async () => {
      const src = checkpoints();
      const index = new PgSearchIndex(pool);
      const handler = indexer({ checkpoints: src, index });
      src.put(TENANT_A, 'doc-class', 1, 'full', paragraph('public wording'));
      src.put(TENANT_A, 'doc-class', 1, 'restricted', paragraph('secret wording'));
      await handler(jobFor(TENANT_A, 'doc-class', 1, 'full'));
      await handler(jobFor(TENANT_A, 'doc-class', 1, 'restricted'));

      const onlyFull = await index.search(TENANT_A, 'wording', {
        readable: new Set(['full']),
        limit: 5,
      });
      expect(onlyFull).toEqual([{ doc: 'doc-class', seq: 1, score: 1 }]);
      expect(
        await index.search(TENANT_A, 'secret', { readable: new Set(['full']), limit: 5 }),
      ).toEqual([]);
      expect(await index.search(TENANT_A, 'secret', { readable: 'all', limit: 5 })).toHaveLength(1);
      expect(await index.search(TENANT_A, 'wording', { readable: new Set(), limit: 5 })).toEqual(
        [],
      );
    });

    it('removes a purged document and its tokens, and nothing else (criterion 3, store part)', async () => {
      const src = checkpoints();
      const index = new PgSearchIndex(pool);
      const handler = indexer({ checkpoints: src, index });
      src.put(TENANT_A, 'doc-purge', 2, 'full', paragraph('purgeable words here'));
      src.put(TENANT_A, 'doc-keep', 2, 'full', paragraph('purgeable words kept'));
      src.put(TENANT_B, 'doc-purge', 2, 'full', paragraph('purgeable words elsewhere'));
      await handler(jobFor(TENANT_A, 'doc-purge', 2, 'full'));
      await handler(jobFor(TENANT_A, 'doc-keep', 2, 'full'));
      await handler(jobFor(TENANT_B, 'doc-purge', 2, 'full'));

      expect(await index.purgeDocument(TENANT_A, 'doc-purge')).toBe(1);
      const left = await index.search(TENANT_A, 'purgeable', { readable: 'all', limit: 10 });
      expect(left.map((h) => h.doc)).toEqual(['doc-keep']);
      const tokens = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM search_tokens WHERE tenant = $1 AND doc = $2`,
        [TENANT_A, 'doc-purge'],
      );
      expect(tokens.rows[0]?.n).toBe('0');
      // The other tenant's document with the same identifier is untouched.
      expect(
        await index.search(TENANT_B, 'purgeable', { readable: 'all', limit: 10 }),
      ).toHaveLength(1);
    });

    it('ranks, limits and orders hits exactly as the in-memory index does', async () => {
      const src = checkpoints();
      const pgIndex = new PgSearchIndex(pool);
      const memIndex = new SearchIndex();
      const docs: [string, string][] = [
        ['d-b', 'red red blue'],
        ['d-a', 'red blue green'],
        ['d-c', 'red'],
        ['d-d', 'blue only'],
      ];
      for (const [i, [doc, text]] of docs.entries()) {
        const content = paragraph(text);
        src.put(TENANT_A, doc, i + 1, 'full', content);
        await pgIndex.indexCheckpoint({
          tenant: TENANT_A,
          doc,
          seq: i + 1,
          visibility: 'full',
          content,
        });
        memIndex.indexCheckpoint({
          tenant: TENANT_A,
          doc,
          seq: i + 1,
          visibility: 'full',
          content,
        });
      }
      for (const q of ['red', 'red blue', 'blue', 'missing', 'red green']) {
        for (const limit of [1, 2, 10]) {
          const query = { readable: 'all' as const, limit };
          expect(await pgIndex.search(TENANT_A, q, query), `${q} ${limit}`).toEqual(
            memIndex.search(TENANT_A, q, query),
          );
        }
      }
      expect(tokenCounts(paragraph('a a b'))).toEqual(
        new Map([
          ['a', 2],
          ['b', 1],
        ]),
      );
    });

    it('keeps preserved content out of the index', async () => {
      const index = new PgSearchIndex(pool);
      const content: JsonNode = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'visible words' }] },
          {
            type: 'preserved_block',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hiddenfragment' }] }],
          },
        ],
      };
      await index.indexCheckpoint({
        tenant: TENANT_A,
        doc: 'doc-pres',
        seq: 1,
        visibility: 'full',
        content,
      });
      expect(await index.search(TENANT_A, 'hiddenfragment', { readable: 'all', limit: 5 })).toEqual(
        [],
      );
      expect(await index.search(TENANT_A, 'visible', { readable: 'all', limit: 5 })).toHaveLength(
        1,
      );
    });

    it('refuses a limit that is not a positive integer', async () => {
      const index = new PgSearchIndex(pool);
      await expect(index.search(TENANT_A, 'x', { readable: 'all', limit: 0 })).rejects.toThrow(
        RangeError,
      );
    });
  },
);
