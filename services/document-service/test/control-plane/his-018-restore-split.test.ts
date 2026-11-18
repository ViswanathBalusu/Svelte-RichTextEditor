// HIS-018 criterion 1 and owner decision 36, over HTTP with the real data plane (lane w7; 08 §8;
// ADR 0408). A region restore is applied as steps of origin `restore`, not as a snapshot commit.
// Steps that are too large for one commit are split into several linked commits: consecutive
// commits of origin `restore` by the same person between the `pre-restore` and the `restore`
// version. Memory and PostgreSQL. Test values only. The three paragraphs of the region are 400 kB
// each, so with the commit limit of 1 MiB (the default) two of them fit one commit and the third
// goes in the next.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const OPEN = 'rOpen00000000001';
const BIG = ['pBig000000000001', 'pBig000000000002', 'pBig000000000003'];

/** The fixture with three large paragraphs in the open region, of the letter `ch`. */
function version(ch: string): Record<string, unknown> {
  const doc = JSON.parse(JSON.stringify(documentWithRegions())) as Record<string, unknown>;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const x = node as { type?: string; attrs?: { id?: string }; content?: unknown[] };
    if (x.type === 'region' && x.attrs?.id === OPEN)
      x.content = BIG.map((id) => ({
        type: 'paragraph',
        attrs: { id, style: 'Normal' },
        content: [{ type: 'text', text: ch.repeat(400_000) }],
      }));
    for (const c of x.content ?? []) walk(c);
  };
  walk(doc['doc']);
  return doc;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`a region restore is steps, split when too large (${storage}, HIS-018)`, async () => {
    const skip = await skipReason(storage);

    it.skipIf(skip)(
      'applies the steps as linked commits of origin restore between the two versions',
      async () => {
        const h = await startHarness(storage, {
          realDataPlane: true,
          config: { testMode: true, environment: 'test' },
        });
        harnesses.push(h);
        const doc = await h.createDocument({ content: version('a'), title: 'Restore split' });
        const ref = { tenant: h.tenant, doc };
        const head = async () =>
          await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
        const put = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
          body: version('b'),
          headers: { 'If-Match': (await head()).headers.get('etag')! },
        });
        expect(put.status, put.text).toBe(204);
        const editorToken = h.userToken({ [doc]: 'editor' }, { sub: 'erin' });
        const before = (await head()).json.seq as number;

        // The dry run says how many commits the restore would be.
        const dry = await h.call('POST', `/v1/documents/${doc}/restore`, {
          token: editorToken,
          body: { toSeq: 0, region: OPEN, dryRun: true },
        });
        expect(dry.status, dry.text).toBe(200);
        expect(dry.json).toMatchObject({ dryRun: true, kind: 'steps', commits: 2 });
        expect((await head()).json.seq).toBe(before);

        const r = await h.call('POST', `/v1/documents/${doc}/restore`, {
          token: editorToken,
          headers: { 'Idempotency-Key': randomUUID() },
          body: { toSeq: 0, region: OPEN },
        });
        expect(r.status, r.text).toBe(200);
        expect(r.json).toMatchObject({
          seq: before + 2,
          toSeq: 0,
          preRestoreSeq: before,
          region: OPEN,
          commits: 2,
        });

        // Two consecutive steps commits of origin restore by the same person, not snapshots.
        const stored = await h.parts.logs.read(ref, before + 1, before + 2);
        expect(stored.map((c) => [c.seq, c.kind, c.origin])).toEqual([
          [before + 1, 'steps', 'restore'],
          [before + 2, 'steps', 'restore'],
        ]);
        expect(stored[0]!.user).toBe(stored[1]!.user);
        // The versions bracket them: pre-restore at the old head, restore at the last commit.
        expect(
          (await h.parts.versions!.list(ref, { kind: 'pre-restore' })).map((v) => v.seq),
        ).toEqual([before]);
        expect((await h.parts.versions!.list(ref, { kind: 'restore' })).map((v) => v.seq)).toEqual([
          before + 2,
        ]);
        // The region holds the text of seq 0 again.
        const now = (await head()).json.doc as unknown;
        const text = JSON.stringify(now);
        expect(text).toContain('a'.repeat(400_000));
        expect(text).not.toContain('b'.repeat(400_000));
      },
      120_000,
    );
  });
}
