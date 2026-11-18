/**
 * BE-053, the measurement half of the search spike (lane w5). It loads a synthetic corpus into
 * PostgreSQL in Podman and times the queries of `GET /search` on two designs:
 *
 * - `fts`: a `tsvector` column with a GIN index, ranked with `ts_rank` (PostgreSQL full-text search);
 * - `tokens`: the token table of `search-index-pg.ts` (BE-054), ranked by occurrences.
 *
 * Nothing here is a product test of a size: the corpus is generated (a Zipf-like vocabulary of
 * 20,000 words, 100 words a document, one tenant), so the figures say how the two designs behave
 * on this corpus on the machine that ran them, not how a customer's text behaves. The sizes come
 * from DOCEDIT_SEARCH_SPIKE_SIZES (default 2000,5000, which keeps the test short and the shared test database, a 2 GiB tmpfs, far from full); the token table
 * is loaded only up to DOCEDIT_SEARCH_SPIKE_TOKENS_MAX documents (default 5000), because it holds
 * one row for each distinct word of each document. The full run is
 *   DOCEDIT_SEARCH_SPIKE_SIZES=10000,100000,1000000 DOCEDIT_SEARCH_SPIKE_TOKENS_MAX=100000
 *   DOCEDIT_SEARCH_SPIKE_OUT=<file.json> pnpm exec vitest run <this file>
 * and the figures it writes are the ones in docs/adr/0386-w5-BE-053-search-design.md.
 *
 * The test database is docedit_w5_be_053_<hex>, created and dropped here. The file skips, with the
 * reason, when PostgreSQL is not up (pwsh -NoProfile -File infra/test-env.ps1 up).
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PgSearchIndex,
  SEARCH_ENTRIES_TABLE,
  SEARCH_INDEX_DDL,
  SEARCH_TOKENS_TABLE,
} from '../../src/control-plane/search-index-pg.ts';
import { ADMIN, postgresUnavailable } from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const SIZES = (process.env['DOCEDIT_SEARCH_SPIKE_SIZES'] ?? '2000,5000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
const TOKENS_MAX = Number(process.env['DOCEDIT_SEARCH_SPIKE_TOKENS_MAX'] ?? '5000');
const OUT = process.env['DOCEDIT_SEARCH_SPIKE_OUT'];
const VOCABULARY = 20_000;
const WORDS_PER_DOC = 100;
const RUNS = 30;
const LIMIT = 20;
const TENANT = 't-w5-be-053';

/** A seeded generator, so that every run draws the same queries. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Bucket {
  name: string;
  /** How many words a query has, and the ranks they are drawn from (1 is the commonest word). */
  terms: number;
  from: number;
  to: number;
}

const BUCKETS: readonly Bucket[] = [
  { name: 'one common word', terms: 1, from: 20, to: 60 },
  { name: 'two common words', terms: 2, from: 20, to: 200 },
  { name: 'two middling words', terms: 2, from: 500, to: 3000 },
  { name: 'three middling words', terms: 3, from: 500, to: 3000 },
  { name: 'one rare word', terms: 1, from: 15_000, to: 20_000 },
  { name: 'two rare words', terms: 2, from: 15_000, to: 20_000 },
];

function queriesOf(b: Bucket, seed: number): string[][] {
  const next = prng(seed);
  return Array.from({ length: RUNS }, () => {
    const words = new Set<string>();
    while (words.size < b.terms) words.add(`w${b.from + Math.floor(next() * (b.to - b.from))}`);
    return [...words];
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const ms = (n: number) => Math.round(n * 100) / 100;

function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: ms(percentile(sorted, 50)),
    p95: ms(percentile(sorted, 95)),
    max: ms(sorted[sorted.length - 1] ?? NaN),
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

describe.skipIf(unavailable !== null)('BE-053 search spike: PostgreSQL full-text search', () => {
  const name = `docedit_w5_be_053_${randomBytes(6).toString('hex')}`;
  let pool: pg.Pool;
  const results: Record<string, unknown>[] = [];
  let machine: Record<string, unknown> = {};

  beforeAll(async () => {
    const root = new pg.Client(ADMIN);
    await root.connect();
    try {
      await root.query(`CREATE DATABASE ${name}`);
    } finally {
      await root.end();
    }
    pool = new pg.Pool({ ...ADMIN, database: name, max: 4 });
    await pool.query(
      `CREATE TABLE docs (tenant text NOT NULL, doc text PRIMARY KEY, vec tsvector NOT NULL)`,
    );
    await pool.query(SEARCH_INDEX_DDL);
    const setting = (n: string) =>
      pool.query<{ v: string }>('SELECT current_setting($1) AS v', [n]);
    const version = await setting('server_version');
    const buffers = await setting('shared_buffers');
    const workMem = await setting('work_mem');
    machine = {
      postgres: version.rows[0]?.v,
      sharedBuffers: buffers.rows[0]?.v,
      workMem: workMem.rows[0]?.v,
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model,
      memoryGiB: Math.round((totalmem() / 2 ** 30) * 10) / 10,
      node: process.version,
    };
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
    if (OUT) writeFileSync(OUT, JSON.stringify({ machine, results }, null, 2));
  }, 120_000);

  it('loads each size, times the queries on both designs, and the two agree on what matches', async () => {
    let loaded = 0;
    for (const size of SIZES) {
      const row: Record<string, unknown> = { documents: size };
      // Load the difference between this size and the last, then build the index once.
      await pool.query('DROP INDEX IF EXISTS docs_vec');
      const load = await timed(() =>
        pool.query(
          `INSERT INTO docs (tenant, doc, vec)
           SELECT $1, 'd' || i,
                  to_tsvector('simple', (
                    SELECT string_agg('w' || (1 + floor($2::int * power(random(), 4)))::int, ' ')
                    FROM generate_series(1, $3::int + (i * 0))))
           FROM generate_series($4::int, $5::int) AS i`,
          [TENANT, VOCABULARY, WORDS_PER_DOC, loaded + 1, size],
        ),
      );
      loaded = size;
      const build = await timed(() => pool.query('CREATE INDEX docs_vec ON docs USING gin (vec)'));
      await pool.query('ANALYZE docs');
      const sizes = await pool.query<{ heap: string; idx: string }>(
        `SELECT pg_relation_size('docs')::text AS heap, pg_relation_size('docs_vec')::text AS idx`,
      );
      row['loadSeconds'] = ms(load.ms / 1000);
      row['indexBuildSeconds'] = ms(build.ms / 1000);
      row['heapMiB'] = Math.round(Number(sizes.rows[0]?.heap) / 2 ** 20);
      row['ginMiB'] = Math.round(Number(sizes.rows[0]?.idx) / 2 ** 20);

      const tokens = size <= TOKENS_MAX;
      if (tokens) {
        await pool.query(`TRUNCATE ${SEARCH_ENTRIES_TABLE} CASCADE`);
        const t = await timed(async () => {
          await pool.query(
            `INSERT INTO ${SEARCH_ENTRIES_TABLE} (tenant, doc, visibility, seq)
             SELECT tenant, doc, 'full', 1 FROM docs`,
          );
          await pool.query(
            `INSERT INTO ${SEARCH_TOKENS_TABLE} (tenant, doc, visibility, token, occurrences)
             SELECT d.tenant, d.doc, 'full', u.lexeme, coalesce(array_length(u.positions, 1), 1)
             FROM docs d, LATERAL unnest(d.vec) AS u`,
          );
        });
        await pool.query(`ANALYZE ${SEARCH_TOKENS_TABLE}`);
        const tsz = await pool.query<{ total: string; rows: string }>(
          `SELECT pg_total_relation_size('${SEARCH_TOKENS_TABLE}')::text AS total,
                  (SELECT count(*) FROM ${SEARCH_TOKENS_TABLE})::text AS rows`,
        );
        row['tokensLoadSeconds'] = ms(t.ms / 1000);
        row['tokenRows'] = Number(tsz.rows[0]?.rows);
        row['tokensTotalMiB'] = Math.round(Number(tsz.rows[0]?.total) / 2 ** 20);
      }

      const index = new PgSearchIndex(pool);
      const queries: Record<string, unknown> = {};
      for (const [bi, b] of BUCKETS.entries()) {
        const qs = queriesOf(b, 53 + bi);
        const fts = (terms: string[]) =>
          pool.query(
            `SELECT d.doc, ts_rank(d.vec, q) AS score
             FROM docs d, to_tsquery('simple', $2) q
             WHERE d.tenant = $1 AND d.vec @@ q
             ORDER BY score DESC, d.doc COLLATE "C" LIMIT ${LIMIT}`,
            [TENANT, terms.join(' & ')],
          );
        const tok = (terms: string[]) =>
          index.search(TENANT, terms.join(' '), { limit: LIMIT, readable: 'all' });
        // One untimed run of each, so that the first timed run is not a cold one.
        await fts(qs[0]!);
        if (tokens) await tok(qs[0]!);
        const ftsMs: number[] = [];
        const tokMs: number[] = [];
        for (const terms of qs) ftsMs.push((await timed(() => fts(terms))).ms);
        if (tokens) for (const terms of qs) tokMs.push((await timed(() => tok(terms))).ms);
        // How many documents the first five queries match (untimed), so the figures can be read.
        const counted: number[] = [];
        for (const terms of qs.slice(0, 5)) {
          const c = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM docs WHERE tenant = $1
               AND vec @@ to_tsquery('simple', $2)`,
            [TENANT, terms.join(' & ')],
          );
          counted.push(Number(c.rows[0]?.n));
        }
        queries[b.name] = {
          matchesOfFirstFive: counted,
          fts: summary(ftsMs),
          ...(tokens ? { tokens: summary(tokMs) } : {}),
        };
        // The two designs must agree on which documents match (ADR 0243): compare with a limit
        // large enough to hold every match of the small queries.
        if (tokens && size <= 10_000 && counted.every((n) => n <= 5_000)) {
          const terms = qs[0]!;
          const a = await pool.query<{ doc: string }>(
            `SELECT doc FROM docs WHERE tenant = $1 AND vec @@ to_tsquery('simple', $2)`,
            [TENANT, terms.join(' & ')],
          );
          const b2 = await index.search(TENANT, terms.join(' '), {
            limit: 10_000,
            readable: 'all',
          });
          expect(new Set(b2.map((h) => h.doc))).toEqual(new Set(a.rows.map((r) => r.doc)));
        }
      }
      row['queries'] = queries;

      // Freshness: replacing the text of one document, which is what an indexer does after a
      // checkpoint. GIN keeps a pending list, so the maximum shows the flushes.
      const update: number[] = [];
      for (let i = 0; i < 100; i++)
        update.push(
          (
            await timed(() =>
              pool.query(
                `UPDATE docs SET vec = to_tsvector('simple', (
                   SELECT string_agg('w' || (1 + floor($2::int * power(random(), 4)))::int, ' ')
                   FROM generate_series(1, $3::int))) WHERE doc = $1`,
                [`d${1 + Math.floor((i * 7919) % size)}`, VOCABULARY, WORDS_PER_DOC],
              ),
            )
          ).ms,
        );
      row['fullTextUpdateOneDocument'] = summary(update);
      results.push(row);
    }
    expect(results.length).toBe(SIZES.length);
  }, 3_600_000);
});
