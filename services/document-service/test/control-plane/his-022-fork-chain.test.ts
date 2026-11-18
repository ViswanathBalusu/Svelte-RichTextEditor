// HIS-022 criterion 2, the log half (lane w7; 08 §8): a copy "starts its own log, its own
// incarnation and its own hash chain". A source with two commits is forked at seq 1
// (the copy holds that content), then the copy takes one commit of its own. Its log holds that commit alone, its chain head is not
// the source's, and on PostgreSQL the chain of the copy verifies from the start (HIS-002), so it
// does not continue the source's chain. Memory and PostgreSQL. Test values only.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

/** The fixture with `text` in the first paragraph. */
function withText(text: string): Record<string, unknown> {
  const env = JSON.parse(JSON.stringify(documentWithRegions())) as Record<string, unknown>;
  const walk = (n: unknown): void => {
    const x = n as { type?: string; attrs?: { id?: string }; content?: unknown[] };
    if (x.type === 'paragraph' && x.attrs?.id === 'pIntro0000000001')
      x.content = [{ type: 'text', text }];
    for (const c of x.content ?? []) walk(c);
  };
  walk(env['doc']);
  return env;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`a fork starts its own hash chain (${storage}, HIS-022)`, async () => {
    const skip = await skipReason(storage);

    it.skipIf(skip)('keeps the copy log and chain apart from the source', async () => {
      const h = await startHarness(storage, { realDataPlane: true });
      harnesses.push(h);
      const source = await h.createDocument({
        content: documentWithRegions(),
        title: 'HIS-022 chain',
      });
      const put = async (doc: string, text = 'Hello') => {
        const etag = (
          await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })
        ).headers.get('etag')!;
        const r = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
          body: withText(text),
          headers: { 'If-Match': etag },
        });
        expect(r.status, r.text).toBe(204);
      };
      await put(source, 'First');
      await put(source, 'Second');
      const sourceRef = { tenant: h.tenant, doc: source };
      expect((await h.parts.logs.head(sourceRef)).seq).toBe(2);

      const forked = await h.call('POST', `/v1/documents/${source}/fork`, {
        token: h.apiKey,
        headers: { 'Idempotency-Key': randomUUID() },
        body: { atSeq: 1 },
      });
      expect(forked.status, forked.text).toBe(201);
      const copy = forked.json.id as string;
      const copyRef = { tenant: h.tenant, doc: copy };
      // The copy has no commit of its own yet: no chain.
      expect((await h.parts.logs.head(copyRef)).seq).toBe(0);
      expect((await h.parts.logs.state!(copyRef)).chainHead).toBeNull();
      // The copy holds the content the source had at seq 1, not its head.
      const text = async (doc: string) =>
        JSON.stringify(
          (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })).json.doc,
        );
      expect(await text(copy)).toContain('First');
      expect(await text(copy)).not.toContain('Second');
      await put(copy, 'Own');

      const sourceHead = await h.parts.logs.head(sourceRef);
      const copyHead = await h.parts.logs.head(copyRef);
      expect(copyHead.incarnation).not.toBe(sourceHead.incarnation);
      expect(copyHead.seq).toBe(1);
      expect((await h.parts.logs.read(copyRef)).map((c) => c.seq)).toEqual([1]);
      const sourceChain = (await h.parts.logs.state!(sourceRef)).chainHead;
      const copyChain = (await h.parts.logs.state!(copyRef)).chainHead;
      expect(copyChain).not.toBeNull();
      expect(copyChain).not.toBe(sourceChain);
      // On PostgreSQL the stored chain of the copy is recomputed from its first commit.
      const verify = (
        h.parts.logs as unknown as {
          verify?: (ref: unknown) => Promise<{ ok: boolean }>;
        }
      ).verify;
      if (storage === 'postgres') {
        expect(verify).toBeTypeOf('function');
        expect(await verify!.call(h.parts.logs, copyRef)).toMatchObject({ ok: true });
        expect(await verify!.call(h.parts.logs, sourceRef)).toMatchObject({ ok: true });
      }
    });
  });
}
