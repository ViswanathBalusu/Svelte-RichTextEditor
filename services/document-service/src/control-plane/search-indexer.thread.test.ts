// BE-054 criterion 5: the indexer job counts the words of a checkpoint in a worker thread, so that no
// room's event loop does it (06 section 1: work that would block the loop runs in worker threads). The
// task runs in the pool of data-plane/workers.ts, which spawns real threads; the thread it ran in is
// not the thread of the test, and the index receives the counts the thread made.
import { threadId } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import { Workers } from '../data-plane/workers.ts';
import type { JobRecord } from './jobs/queue.ts';
import { SearchIndex } from './search-index.ts';
import { createSearchIndexHandler } from './search-indexer.ts';

const paragraph = (text: string): JsonNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('the indexer counts words off the event loop (BE-054 criterion 5)', () => {
  const workers = new Workers({ size: 1, timeoutMs: 20_000 });
  afterAll(() => workers.close());

  it('runs the counting task in a worker thread, not in the thread that runs the job', async () => {
    const ran = await workers.run('searchTokens', { doc: paragraph('red red blue') });
    expect(threadId).toBe(0);
    expect(ran.threadId).toBeGreaterThan(0);
    expect(new Map(ran.tokens)).toEqual(
      new Map([
        ['red', 2],
        ['blue', 1],
      ]),
    );
    expect(workers.stats.inline).toBe(0);
  });

  it('indexes the counts the thread made, and finds them', async () => {
    const index = new SearchIndex();
    let counted = 0;
    const handler = createSearchIndexHandler({
      checkpoints: { readCheckpoint: async () => paragraph('green green green') },
      index,
      tokenise: async (content) => {
        counted++;
        return new Map((await workers.run('searchTokens', { doc: content })).tokens);
      },
    });
    const job = {
      tenant: 't-a',
      doc: 'doc-1',
      kind: 'search-index',
      payload: { doc: 'doc-1', seq: 1, visibility: 'full' },
    } as unknown as JobRecord;
    const ctx = { signal: new AbortController().signal, report: async () => 'ok' as const };
    await expect(handler(job, ctx as never)).resolves.toEqual({ indexed: true, seq: 1 });
    expect(counted).toBe(1);
    expect(index.search('t-a', 'green', { readable: 'all', limit: 5 })).toEqual([
      { doc: 'doc-1', seq: 1, score: 3 },
    ]);
  });

  it('leaves the count to the index when no tokeniser is given', async () => {
    const index = new SearchIndex();
    const handler = createSearchIndexHandler({
      checkpoints: { readCheckpoint: async () => paragraph('plain words') },
      index,
    });
    const job = {
      tenant: 't-a',
      doc: 'doc-2',
      kind: 'search-index',
      payload: { doc: 'doc-2', seq: 1, visibility: 'full' },
    } as unknown as JobRecord;
    await handler(job, { signal: new AbortController().signal, report: async () => 'ok' } as never);
    expect(index.search('t-a', 'plain', { readable: 'all', limit: 5 })).toHaveLength(1);
  });
});
