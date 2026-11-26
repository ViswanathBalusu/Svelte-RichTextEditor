// UX-084 criteria 3 and 4 in the composed service, in memory (the PostgreSQL run of the same flow
// is test/postgres/be-054-wired.pg.test.ts): a saved document is searchable once the indexer job of
// its checkpoint has committed, which is the freshness BE-053 recommends (ADR 0386, "Freshness":
// the entry is written in the transaction of the indexer job), and a purged document leaves the
// index. The elapsed time from the save to the first hit is measured and reported by the test, not
// asserted against a figure: the spec sets no search target (open, the owner's). Test values only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentPurge, type PurgeStore } from '../../src/control-plane/document-purge.ts';
import { MemoryAudit } from '../../src/data-plane/memory-ports.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const DAY_MS = 86_400_000;

function edited(text: string): Record<string, unknown> {
  const env = structuredClone(documentWithRegions()) as Record<string, unknown>;
  const walk = (n: unknown): boolean => {
    if (n === null || typeof n !== 'object') return false;
    const o = n as Record<string, unknown>;
    if (typeof o['text'] === 'string') {
      o['text'] = text;
      return true;
    }
    return Object.values(o).some(walk);
  };
  walk(env['doc']);
  return env;
}

describe('search after a save and after a purge (UX-084 criteria 3 and 4)', () => {
  let h: Harness;
  let doc: string;
  const word = `quokka${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const search = (q: string) =>
    h.call('GET', `/v1/search?q=${encodeURIComponent(q)}&limit=10`, { token: h.apiKey });

  beforeAll(async () => {
    h = await startHarness('memory', {
      realDataPlane: true,
      config: { searchIndex: true, jobIdleMs: 50 },
    });
    doc = await h.createDocument({ content: documentWithRegions(), title: 'UX-084' });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it('finds the new text once the indexer job has committed, and not before the save', async () => {
    expect((await search(word)).json.items).toEqual([]);
    const etag = (
      await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })
    ).headers.get('etag');
    const saved = Date.now();
    const put = await h.call('PUT', `/v1/documents/${doc}/content`, {
      token: h.apiKey,
      body: edited(`the ${word} crossed the road`),
      headers: { 'If-Match': etag! },
    });
    expect(put.status, put.text).toBe(204);

    let hit = await search(word);
    while ((hit.json.items as unknown[]).length === 0 && Date.now() - saved < 20_000) {
      await new Promise((r) => setTimeout(r, 25));
      hit = await search(word);
    }
    const elapsedMs = Date.now() - saved;
    const items = hit.json.items as Array<{ doc: string; seq: number }>;
    expect(items.map((i) => i.doc)).toEqual([doc]);
    // Measured on this machine, in memory, with the indexer's idle wait set to 50 ms (jobIdleMs):
    // a record of the test run, not a target.
    console.info(`UX-084: the saved text was first found ${elapsedMs} ms after the save`);
    expect(elapsedMs).toBeLessThan(20_000);
  });

  it('removes the entries of a purged document from the index', async () => {
    let removed = false;
    const store: PurgeStore = {
      deleted: async () => (removed ? [] : [{ doc, deletedAt: Date.now() - 31 * DAY_MS }]),
      assets: async () => [],
      jobs: async () => [],
      sealed: async () => [],
      remove: async () => {
        removed = true;
      },
    };
    const purge = new DocumentPurge({
      store,
      objects: h.parts.objects,
      audit: new MemoryAudit(),
      search: h.service.parts.searchPurge!,
      retentionMs: 30 * DAY_MS,
      now: () => Date.now(),
    });
    expect((await search(word)).json.items).toHaveLength(1);
    const run = await purge.run(h.tenant);
    expect(run.purged).toEqual([doc]);
    expect((await search(word)).json.items).toEqual([]);
  });
});
