/**
 * SEC-037 criterion 3 (lane w8): a commit that references an asset the submitter never uploaded for
 * this document, an asset of another document, or an asset of another tenant is rejected with
 * `invalid_op`, through the real service over a real WebSocket (05 §5; 06 §4.4; 03 §8, I4).
 *
 * The attached-asset source is BE-044's (services/document-service/src/data-plane/asset-attachments.ts,
 * built after the story's earlier rounds): the room asks the tenant's asset registry for an identifier
 * it does not know, and a commit that names an asset outside the document's set is refused. The
 * assets here are registered ready, as the asset worker leaves them; the commits are the ones a
 * hostile client would send. The room half is tests/security/test/sec-037-asset-refs-room.test.ts.
 * Runs on memory and, when PostgreSQL is available, on PostgreSQL.
 */
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  posInside,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const figure = (asset: string, id: string) => ({
  type: 'figure',
  attrs: { id, asset, width: 2400, height: 1800 },
});
/** A step that inserts a figure at `at`, naming `asset`. */
const insertFigure = (at: number, asset: string, id: string) => ({
  stepType: 'replace',
  from: at,
  to: at,
  slice: { content: [figure(asset, id)] },
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-037 criterion 3: commits that reference assets (${storage})`, () => {
    let h: Harness;
    let docA: string;
    let docOther: string;
    let docOfB: string;
    let token: string;
    let bob: string;
    let at: number;
    const t = () => (skip ? it.skip : it);

    /**
     * An asset the worker left ready. With a user `token` the upload is declared through
     * `POST /documents/{id}/assets`, so the row names that user as its uploader; without one the row
     * is written for a user of another tenant, who has no token here.
     */
    const uploaded = async (tenant: string, doc: string, token?: string): Promise<string> => {
      let id = uuid7();
      if (token) {
        const declared = await h.call('POST', `/v1/documents/${doc}/assets`, {
          token,
          body: { filename: 'a.png', mime: 'image/png', size: 10 },
        });
        expect(declared.status, declared.text).toBe(201);
        id = declared.json.asset as ReturnType<typeof uuid7>;
      } else
        await h.parts.assetRegistry.create(
          tenant,
          {
            id,
            doc,
            filename: 'a.png',
            mime: 'image/png',
            declaredBytes: 10,
            createdBy: 'bella',
            uploadExpiresAt: Date.now() + 60_000,
          },
          Date.now(),
        );
      await h.parts.assetRegistry.settleReady(
        tenant,
        id,
        {
          sha256: 'a'.repeat(64),
          bytes: 10,
          contentType: 'image/png',
          objectKey: `k/${id}`,
          width: 10,
          height: 10,
          frames: null,
          renditions: [],
        },
        Date.now(),
      );
      return id;
    };

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
      docA = await h.createDocument(h.a, documentWithRegions());
      docOther = await h.createDocument(h.a, documentWithRegions());
      docOfB = await h.createDocument(h.b, documentWithRegions());
      // The caller owns both of tenant A's documents, so only the asset can be what is refused.
      token = await h.mintToken(h.a, 'ann', { [docA]: 'owner', [docOther]: 'owner' });
      bob = await h.mintToken(h.a, 'bob', { [docA]: 'editor' });
      at = posInside(documentWithRegions()['doc'], 'pIntro0000000001') - 1;
    });
    afterAll(async () => {
      await h?.close();
    });

    /** Opens `docA`, submits one commit with the steps, and gives the answer and the head. */
    const submit = async (steps: unknown[]) => {
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      try {
        expect((await c.hello(token)).t).toBe('welcome');
        const opened = await c.open(1, docA);
        expect(opened.t, JSON.stringify(opened)).toBe('ch.opened');
        const answer = await c.submit(1, { id: uuid7(), base: await headSeq(), steps });
        return answer;
      } finally {
        c.close();
      }
    };
    const headSeq = async () =>
      (await h.call('GET', `/v1/documents/${docA}/content`, { token: h.a.apiKey })).json
        .seq as number;
    const content = async () =>
      (await h.call('GET', `/v1/documents/${docA}/content`, { token: h.a.apiKey })).text;

    t()(
      'refuses an asset nobody uploaded, one of another document, one of another tenant and one of another user',
      async () => {
        const before = await headSeq();
        const cases: Array<[string, string]> = [
          ['an identifier that names no asset', uuid7()],
          [
            'an asset uploaded for another document of the tenant',
            await uploaded(h.a.id, docOther, token),
          ],
          [
            'an asset of another tenant, for a document of that tenant',
            await uploaded(h.b.id, docOfB),
          ],
          // The same document identifier in the other tenant: still not tenant A's asset.
          ['an asset of another tenant named for this document', await uploaded(h.b.id, docA)],
          ['an asset another user uploaded for this document', await uploaded(h.a.id, docA, bob)],
        ];
        let n = 0;
        for (const [what, asset] of cases) {
          const answer = await submit([insertFigure(at, asset, `fRefused00000000${++n}`)]);
          expect(answer.t, `${what}: ${JSON.stringify(answer)}`).toBe('sync.reject');
          expect(answer.d?.['code'], what).toBe('invalid_op');
          expect(await content(), what).not.toContain(asset);
        }
        // Nothing was stored for any of them.
        expect(await headSeq()).toBe(before);
      },
    );

    t()(
      'accepts the same figure for an asset the submitter uploaded for this document (the control)',
      async () => {
        const before = await headSeq();
        const own = await uploaded(h.a.id, docA, token);
        const answer = await submit([insertFigure(at, own, 'fAccepted0000001')]);
        expect(answer.t, JSON.stringify(answer)).toBe('sync.ack');
        expect(await headSeq()).toBe(before + 1);
        expect(await content()).toContain(own);
        // Another asset of the same document stays refused after the first was accepted.
        const other = await uploaded(h.a.id, docOther, token);
        const refused = await submit([insertFigure(at, other, 'fRefused00000009')]);
        expect(refused.t).toBe('sync.reject');
        expect(refused.d?.['code']).toBe('invalid_op');
      },
    );
  });
}
