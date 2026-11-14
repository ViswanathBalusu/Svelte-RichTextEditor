// The indexer job (BE-054 criteria 1 and 4; criterion 5 is not shown here). The job runs through
// the real JobRunner on the in-memory queue; the index is the in-memory SearchIndex. The PostgreSQL
// search tables and a PostgreSQL queue were not run (no database in this lane).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import { MemoryJobQueue } from './jobs/queue.ts';
import { JobRunner, type JobOutcome } from './jobs/runner.ts';
import {
  SEARCH_INDEX_KIND,
  createSearchIndexHandler,
  enqueueIndexing,
  type CheckpointSource,
} from './search-indexer.ts';
import { SearchIndex } from './search-index.ts';

/** A checkpoint source held in memory, keyed by tenant, document, sequence and class. */
function memoryCheckpoints(): CheckpointSource & {
  put(tenant: string, doc: string, seq: number, visibility: string, content: JsonNode): void;
  reads: [string, string, number, string][];
} {
  const held = new Map<string, JsonNode>();
  const reads: [string, string, number, string][] = [];
  return {
    reads,
    put(tenant, doc, seq, visibility, content) {
      held.set(JSON.stringify([tenant, doc, seq, visibility]), content);
    },
    async readCheckpoint(tenant, doc, seq, visibility) {
      reads.push([tenant, doc, seq, visibility]);
      return held.get(JSON.stringify([tenant, doc, seq, visibility])) ?? null;
    },
  };
}

const paragraph = (text: string): JsonNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** Runs the queued jobs once, and returns how each one ended. */
async function runAll(
  queue: MemoryJobQueue,
  handler: ReturnType<typeof createSearchIndexHandler>,
): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = [];
  const runner = new JobRunner({
    queue,
    handlers: { [SEARCH_INDEX_KIND]: handler },
    worker: 'indexer-test',
    leaseMs: 60_000,
    idleMs: 5,
    retryAfterMs: 5,
    hooks: {
      settled: (_job, outcome) => {
        outcomes.push(outcome);
      },
    },
  });
  while (await runner.runOnce()) {
    // Each call claims and settles one job.
  }
  return outcomes;
}

describe('the indexer job indexes a checkpoint through the job runner (BE-054 criterion 1)', () => {
  it('reads the checkpoint of the job and makes its text searchable for the job tenant', async () => {
    const queue = new MemoryJobQueue();
    const checkpoints = memoryCheckpoints();
    const index = new SearchIndex();
    checkpoints.put('t-a', 'doc-1', 4, 'full', paragraph('quarterly budget report'));
    await enqueueIndexing(queue, 't-a', { doc: 'doc-1', seq: 4, visibility: 'full' });

    const outcomes = await runAll(queue, createSearchIndexHandler({ checkpoints, index }));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.state).toBe('completed');
    expect(index.search('t-a', 'budget', { readable: 'all', limit: 5 })).toEqual([
      { doc: 'doc-1', seq: 4, score: 1 },
    ]);
    // The tenant of the read is the tenant of the job row.
    expect(checkpoints.reads).toEqual([['t-a', 'doc-1', 4, 'full']]);
  });

  it('keeps the tenants apart: another tenant finds nothing in the same document identifier', async () => {
    const queue = new MemoryJobQueue();
    const checkpoints = memoryCheckpoints();
    const index = new SearchIndex();
    checkpoints.put('t-a', 'doc-1', 1, 'full', paragraph('alpha beta'));
    checkpoints.put('t-b', 'doc-1', 1, 'full', paragraph('gamma delta'));
    await enqueueIndexing(queue, 't-a', { doc: 'doc-1', seq: 1, visibility: 'full' });
    await enqueueIndexing(queue, 't-b', { doc: 'doc-1', seq: 1, visibility: 'full' });

    await runAll(queue, createSearchIndexHandler({ checkpoints, index }));

    expect(index.search('t-a', 'alpha', { readable: 'all', limit: 5 })).toHaveLength(1);
    expect(index.search('t-a', 'gamma', { readable: 'all', limit: 5 })).toEqual([]);
    expect(index.search('t-b', 'gamma', { readable: 'all', limit: 5 })).toHaveLength(1);
  });

  it('indexes a restricted class under its own visibility, so a principal without it does not find it', async () => {
    const queue = new MemoryJobQueue();
    const checkpoints = memoryCheckpoints();
    const index = new SearchIndex();
    checkpoints.put('t-a', 'doc-1', 2, 'restricted', paragraph('salary review'));
    await enqueueIndexing(queue, 't-a', { doc: 'doc-1', seq: 2, visibility: 'restricted' });

    await runAll(queue, createSearchIndexHandler({ checkpoints, index }));

    expect(index.search('t-a', 'salary', { readable: new Set(['full']), limit: 5 })).toEqual([]);
    expect(
      index.search('t-a', 'salary', { readable: new Set(['restricted']), limit: 5 }),
    ).toHaveLength(1);
  });

  it('fails without a retry when the checkpoint named by the job does not exist', async () => {
    const queue = new MemoryJobQueue();
    const index = new SearchIndex();
    await enqueueIndexing(queue, 't-a', { doc: 'doc-x', seq: 9, visibility: 'full' });

    const outcomes = await runAll(
      queue,
      createSearchIndexHandler({ checkpoints: memoryCheckpoints(), index }),
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      state: 'failed',
      error: { code: 'not_found' },
      retried: false,
    });
    expect(index.size('t-a')).toBe(0);
  });

  it('does not index an older checkpoint over a newer one that is already held', async () => {
    const queue = new MemoryJobQueue();
    const checkpoints = memoryCheckpoints();
    const index = new SearchIndex();
    checkpoints.put('t-a', 'doc-1', 5, 'full', paragraph('newer words'));
    checkpoints.put('t-a', 'doc-1', 3, 'full', paragraph('older words'));
    await enqueueIndexing(queue, 't-a', { doc: 'doc-1', seq: 5, visibility: 'full' });
    await enqueueIndexing(queue, 't-a', { doc: 'doc-1', seq: 3, visibility: 'full' });

    await runAll(queue, createSearchIndexHandler({ checkpoints, index }));

    expect(index.search('t-a', 'older', { readable: 'all', limit: 5 })).toEqual([]);
    expect(index.search('t-a', 'newer', { readable: 'all', limit: 5 })).toEqual([
      { doc: 'doc-1', seq: 5, score: 1 },
    ]);
  });

  it('refuses a queued sequence or class that is not valid, before the job exists', async () => {
    const queue = new MemoryJobQueue();
    await expect(
      enqueueIndexing(queue, 't-a', { doc: 'doc-1', seq: -1, visibility: 'full' }),
    ).rejects.toThrow(RangeError);
    await expect(
      enqueueIndexing(queue, 't-a', { doc: 'doc-1', seq: 1, visibility: '' }),
    ).rejects.toThrow(RangeError);
  });
});

describe('the indexer holds no credentials (BE-054 criterion 4)', () => {
  it('takes only a checkpoint source and the index, and nothing else', () => {
    const deps = { checkpoints: memoryCheckpoints(), index: new SearchIndex() };
    expect(Object.keys(deps).sort()).toEqual(['checkpoints', 'index']);
    const handler = createSearchIndexHandler(deps);
    // The handler is a function of the job and the runner's context only.
    expect(handler.length).toBeLessThanOrEqual(2);
  });

  it('imports no network, file, process or credential module, and reads no environment', () => {
    for (const name of ['search-indexer.ts', 'search-index.ts']) {
      const path = fileURLToPath(new URL(name, import.meta.url));
      const code = stripComments(readFileSync(path, 'utf8'));
      const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
      for (const spec of imports)
        expect(
          spec.startsWith('.') || spec.startsWith('@docedit/'),
          `${name} imports ${spec}`,
        ).toBe(true);
      expect(code).not.toMatch(/\bfetch\s*\(/);
      expect(code).not.toMatch(/process\.env|require\s*\(|\bWebSocket\b|\bXMLHttpRequest\b/);
      // A search token is a word of the text, not an access token, so the word is not in the list.
      expect(
        code.match(/credential|secret|password|apiKey|api_key|bearer/i)?.[0] ?? null,
        name,
      ).toBeNull();
    }
  });

  it('never evaluates the content it indexes (property, hostile markup stored as plain text)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 40 }), async (hostile) => {
        const queue = new MemoryJobQueue();
        const checkpoints = memoryCheckpoints();
        const index = new SearchIndex();
        const text = `<script>x()</script> ${hostile}`;
        checkpoints.put('t-p', 'doc-p', 1, 'full', paragraph(text));
        await enqueueIndexing(queue, 't-p', { doc: 'doc-p', seq: 1, visibility: 'full' });
        const outcomes = await runAll(queue, createSearchIndexHandler({ checkpoints, index }));
        expect(outcomes[0]?.state).toBe('completed');
        expect(index.search('t-p', 'script', { readable: 'all', limit: 5 })).toHaveLength(1);
      }),
      { numRuns: 25 },
    );
  });
});

/** Removes block and line comments, so that words in comments do not count as code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
