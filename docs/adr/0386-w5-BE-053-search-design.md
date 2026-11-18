# 0386. Search across documents: PostgreSQL full-text search or a search engine (BE-053)

Status: proposed (lane w5, 2026-11-18). Not an owner decision. It completes the search design of
[ADR 0243](0243-lane-BE-053-065.md), which answered criteria 2 to 5 of BE-053 and left criterion 1
open for want of a measurement.

## Context

06 §16 says search across documents needs its own document: ranking, permissions in results and the
move from PostgreSQL full-text search to a search engine. ADR 0243 records what is indexed, the
shape of `GET /search`, permissions, ranking and tenant isolation. This record answers the one
question left: is PostgreSQL full-text search enough, how does it compare with a search engine, and
when does the service move.

## What was measured

A spike, `services/document-service/test/postgres/be-053-search-spike.pg.test.ts`, loads a generated
corpus and times the queries of `GET /search` on two designs:

- `fts`: a `tsvector` column with a GIN index, matched with `@@` and ranked with `ts_rank`;
- `tokens`: the token table of `search-index-pg.ts` (BE-054), which holds one row for each distinct
  word of each document and ranks by occurrences.

How, and where:

- The corpus is generated, not real. Each document has 100 words drawn from a vocabulary of 20,000
  with a skewed distribution (`1 + floor(20000 * random()^4)`), so a few words are very common. One
  tenant holds every document, which is the worst case for a tenant filter. Real text will differ.
- PostgreSQL 17.11 in a Podman container on the WSL machine (10 CPUs and 2 GiB of memory given to the
  machine), `shared_buffers` 256 MB, `work_mem` 4 MB, data on a disk volume. The shared test
  database of the repository is a 2 GiB tmpfs and cannot hold the largest size; the spike used a
  container of its own, now removed. The client is Node.js 22.18 on the same host (Intel Core
  i9-10900KF, 20 threads, 127.8 GiB).
- Each query is one connection, one statement, `LIMIT 20`, timed from the client, including the
  round trip to the container. 30 queries for each bucket, drawn with a fixed seed, after one
  untimed run. The cache is warm. There was no other load on the database during the run, and
  other work on the host was kept off while it ran. The run is one run: no repeat.
- Sizes: 10,000, 100,000 and 1,000,000 documents for `fts`; 10,000 and 100,000 for `tokens`, which
  was not loaded at 1,000,000 because it holds about 89 rows for each document (8.9 million rows,
  1.4 GiB at 100,000 documents).
- The raw figures are in `docs/research/2026-11-18-be-053-search-spike.json`. Run again with
  `DOCEDIT_SEARCH_SPIKE_SIZES=10000,100000,1000000 DOCEDIT_SEARCH_SPIKE_TOKENS_MAX=100000
  DOCEDIT_SEARCH_SPIKE_OUT=<file> DOCEDIT_PG_PORT=<port of a database with room>`.

Query time in milliseconds, p50 / p95 (`fts`). "Matches" is the number of documents that match, for
the first five queries of the bucket.

| Query | 10,000 documents | 100,000 documents | 1,000,000 documents |
|---|---|---|---|
| One common word (matches 1,100 to 1,800; 11,000 to 18,600; 110,000 to 184,000) | 4.2 / 22.3 | 31.5 / 61.2 | 358 / 497 |
| Two common words (matches 23 to 81; 186 to 920; 1,982 to 9,193) | 1.1 / 1.8 | 4.4 / 12.5 | 32.8 / 99.6 |
| Two middling words (matches 0 to 4; 4 to 29; 53 to 284) | 0.7 / 2.1 | 1.8 / 13.9 | 3.2 / 7.5 |
| Three middling words (matches 0 to 1) | 0.7 / 0.9 | 1.0 / 3.6 | 2.7 / 8.6 |
| One rare word (matches 12 to 17; 127 to 151; 1,248 to 1,410) | 0.7 / 1.0 | 1.9 / 3.2 | 9.6 / 18.0 |
| Two rare words (matches 0 to 1) | 0.7 / 1.0 | 0.9 / 1.2 | 1.2 / 3.8 |

The token table, same queries, p50 / p95: at 10,000 documents 7 to 188 ms and 13 to 277 ms; at
100,000 documents 4 to 148 ms and 7 to 211 ms (one common word 148 / 194; two common words 139 / 197;
three middling words 78 / 147; one rare word 4.2 / 6.8). The token table was slower than full-text
search on every bucket at both sizes: by a factor of 2 to 170 at the p50.

Sizes on disk (`fts`): 1,000,000 documents took a 1,302 MiB heap and a 397 MiB GIN index; the index
took 158 s to build after 174 s to load. The token table took 1,366 MiB at 100,000 documents, where
`fts` took 130 MiB of heap and 35 MiB of index.

Replacing the text of one document (an indexer's update after a checkpoint): p50 / p95 / maximum of
100 updates, 22.9 / 46.2 / 57.2 ms at 10,000 documents, 7.5 / 19.7 / 36.2 ms at 100,000 and
12.7 / 32.2 / 99.7 ms at 1,000,000. The larger figure at 10,000 documents is not explained; the
spike was not repeated.

The test also checks, at 10,000 documents or fewer, that both designs match the same set of
documents for a query (ADR 0243 asks for that agreement).

## Findings

1. PostgreSQL full-text search answered the selective queries (middling and rare words) in a p95
   under 20 ms at 1,000,000 documents of 100 words each, on this corpus and this machine.
2. Its weak point is a query whose words are in a large share of the documents. One word that
   matches 11 to 18 per cent of the documents took a p95 of 497 ms at 1,000,000 documents, because
   `ts_rank` scores every match before the sort. Two such words took 99.6 ms. This is the cost to
   watch, and it grows with the size and with the share of matches. The spike did not try to reduce
   it (a stop-word list, a cap on the documents ranked, ranking only the best N by a cheaper
   score).
3. The token table of BE-054 is not competitive: its p50 is 2 to 170 times that of `fts` on the same
   corpus where both were measured, and at 100,000 documents it takes about eight times the space. It should not be the
   production design if PostgreSQL is the search store. The query tests of `search-index-pg.ts`
   (tenant scope, class filter, purge, the sequence guard) carry over to a `tsvector` column, which
   needs `(tenant, doc, visibility)` as its key and a GIN index. Nothing is changed here; that is
   BE-054's decision.

## Comparison with a search engine

No search engine was run. The points below are properties of the two kinds of system, not
measurements, and the cost point is a statement about what has to be operated.

- **Ranking.** PostgreSQL gives `ts_rank` and `ts_rank_cd` with weights and a `simple` or a
  language configuration, and no typo tolerance, no phrase-aware relevance beyond `ts_rank_cd`, and
  no facets. A search engine gives tunable relevance, typo tolerance, synonyms, facets and more
  language analysers. The spec asks for none of these (05 §6.2: `q` and `limit`).
- **Freshness.** A `tsvector` is written in the transaction that writes the entry, so a committed
  checkpoint is searchable when the indexer job commits (the update times above). An engine indexes
  asynchronously, so its results lag the log by its refresh interval and by any backlog of a sync
  path; it needs a rebuild path after a restore (ADR 0243 open item).
- **Cost.** PostgreSQL adds nothing to run, which matters for a self-hosted install (06 §4). An engine
  is a second service to run, secure and back up, holds a second copy of the text (which is subject
  to the same erasure and retention rules as the first, SEC-045, SEC-057, HIS-038) and has its own
  tenant-isolation surface (a tenant filter or an index for each tenant, in every query).

## Proposed decision

1. PostgreSQL full-text search is enough for version 1 and for the stage 3 size the spec states
   (06 §4: 1,000,000 or more stored documents). The measurement above shows selective queries stay
   fast at that count of 100-word documents. It does not show how real documents behave, and it did
   not use real queries.
2. The size at which a search engine is needed is not a count of documents. What was found is that
   the cost grows with the number of documents that match a query, not with the count held. So the
   rule to move is a measured one: move when the p95 of the search on the target corpus, measured by
   this spike on a copy of real text or by the BE-058 harness, misses the search target. The spec
   sets no search target, so the owner sets one. The spike gives the owner the figures to choose it
   from: at 1,000,000 documents, selective queries under 20 ms at p95 and a single very common word
   at about 500 ms.
3. Move also, whatever the size, when the owner requires a relevance feature that PostgreSQL does
   not give (typo tolerance, facets, a language analyser it lacks), or when index updates are
   shown to slow the commit path on the same primary. Before moving for size alone, try the cheap
   measures of finding 2 and a read replica (BE-064), and measure again.
4. Use `tsvector` with a GIN index and `ts_rank` instead of the token table. This changes BE-054's
   store and is its owner's to accept.
5. Keep search behind the index interface of ADR 0243 (`SearchIndex`, `PgSearchIndex`), so that an
   engine can replace PostgreSQL without a change to the route, the permissions or the purge rule.

## What this does not settle

- The search target (a p95 and the query mix it is measured on): the owner's.
- Real text. A real document is longer than 100 words, so the index is larger than the figures
  above for the same count, and real queries are not Zipf-like draws.
- Behaviour with many tenants at once, with concurrent searches, with indexing running during
  searches, and on a machine without a warm cache.
- The cheap measures of finding 2.
