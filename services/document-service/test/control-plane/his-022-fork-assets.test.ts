// HIS-022 criterion 5 (lane w7; 08 §8; invariant I4): the assets the copied content references are
// attached to the copy from seq 0, so that its references resolve. Only assets the source holds
// are attached (the route looks each referenced identifier up among the source's `doc_assets` rows).
// The objects are shared by hash, so nothing is copied but the rows. Memory and PostgreSQL. Test values only.
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const figure = (asset: string, id: string) => ({
  type: 'figure',
  attrs: { id, asset, width: 2400, height: 1800 },
});

/** The fixture with figures that name `assets`, after the last paragraph. */
function withFigures(assets: readonly string[]): Record<string, unknown> {
  const env = JSON.parse(JSON.stringify(documentWithRegions())) as {
    doc: { content: Array<{ type: string; content?: unknown[] }> };
  };
  const body = env.doc.content.find((n) => n.type === 'body');
  if (!body?.content) throw new Error('the fixture has no body');
  assets.forEach((a, i) => body.content!.push(figure(a, `fFigure00000000${i + 1}`)));
  return env as unknown as Record<string, unknown>;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`a fork attaches the assets its content references (${storage}, HIS-022)`, async () => {
    const skip = await skipReason(storage);

    it.skipIf(skip)(
      'attaches the assets of the copied content at seq 0, and none for a copy of content that has none',
      async () => {
        const h = await startHarness(storage, { realDataPlane: true });
        harnesses.push(h);
        const [one, two] = [uuid7(), uuid7()];
        const source = await h.createDocument({ title: 'HIS-022 assets' });
        const sourceRef = { tenant: h.tenant, doc: source };
        const registry = h.parts.assetRegistry;
        const by = (await h.parts.users.resolve(h.tenant, 'alice')).surrogate;
        for (const id of [one, two]) {
          await registry.create(
            h.tenant,
            {
              id,
              doc: source,
              filename: 'a.png',
              mime: 'image/png',
              declaredBytes: 10,
              createdBy: by,
              uploadExpiresAt: Date.now() + 60_000,
            },
            Date.now(),
          );
          await registry.settleReady(
            h.tenant,
            id,
            {
              sha256: id.replaceAll('-', '').padEnd(64, '0'),
              bytes: 10,
              contentType: 'image/png',
              objectKey: `assets/${id}`,
              width: 1,
              height: 1,
              frames: 1,
              renditions: [],
            },
            Date.now(),
          );
        }
        // The content at seq 1 references both; the commit that stores it attaches them.
        const etag = (
          await h.call('GET', `/v1/documents/${source}/content`, { token: h.apiKey })
        ).headers.get('etag')!;
        const put = await h.call('PUT', `/v1/documents/${source}/content`, {
          token: h.apiKey,
          body: withFigures([one, two]),
          headers: { 'If-Match': etag },
        });
        expect(put.status, put.text).toBe(204);
        // A composition without the attachment check stores no rows; the route needs them either way.
        await h.parts.logs.attachAssets!(sourceRef, [
          { asset: one, seq: 1 },
          { asset: two, seq: 1 },
        ]);
        const before = [...(await h.parts.logs.attachedAssets!(sourceRef))];

        const fork = (atSeq: number) =>
          h.call('POST', `/v1/documents/${source}/fork`, { token: h.apiKey, body: { atSeq } });
        const copy = await fork(1);
        expect(copy.status, copy.text).toBe(201);
        const copyRef = { tenant: h.tenant, doc: copy.json.id as string };
        const attached = await h.parts.logs.attachedAssets!(copyRef);
        // Both assets, from seq 0 of the copy.
        expect([...attached].sort()).toEqual(
          [
            [one, 0],
            [two, 0],
          ].sort(),
        );
        // The source is as it was.
        expect([...(await h.parts.logs.attachedAssets!(sourceRef))]).toEqual(before);

        // A copy of the content before the figures holds no figure and takes no row.
        const bare = await fork(0);
        expect(bare.status, bare.text).toBe(201);
        expect([
          ...(await h.parts.logs.attachedAssets!({
            tenant: h.tenant,
            doc: bare.json.id as string,
          })),
        ]).toEqual([]);
      },
    );
  });
}
