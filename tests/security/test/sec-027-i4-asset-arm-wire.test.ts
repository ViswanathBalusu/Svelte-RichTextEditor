/**
 * SEC-027 criterion 2, the part the matrix of sec-027-invariant-matrix.test.ts could not reach (lane
 * w8, 2026-11-25): the asset arm of I4 over the wire, with the step types that can break it. The
 * matrix runs at the Room; the data plane gives the Room the document's attached assets since BE-044
 * (services/document-service/src/data-plane/asset-attachments.ts), so a commit that names an asset
 * the document does not hold is refused by the deployed composition too. `replace` is also proved by
 * sec-037-asset-refs-wire.test.ts; here `attr` (changing the asset of a figure already in the
 * document) is added. The asset arm is reached by those two step types only: a mark carries no
 * asset, and `replaceAround` wraps content that already passed the check. Memory and, when
 * PostgreSQL is available, PostgreSQL.
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

const FIGURE_ID = 'fSec027Figure001';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-027 criterion 2: the asset arm of I4 over the wire (${storage})`, () => {
    let h: Harness;
    let doc: string;
    let other: string;
    let token: string;
    let at: number;

    /** An asset the worker left ready, declared by `token` for `forDoc`. */
    const uploaded = async (forDoc: string): Promise<string> => {
      const declared = await h.call('POST', `/v1/documents/${forDoc}/assets`, {
        token,
        body: { filename: 'a.png', mime: 'image/png', size: 10 },
      });
      expect(declared.status, declared.text).toBe(201);
      const id = declared.json.asset as string;
      await h.parts.assetRegistry.settleReady(
        h.a.id,
        id,
        {
          sha256: 'b'.repeat(64),
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
    const head = async () =>
      (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })).json
        .seq as number;
    const content = async () =>
      (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })).text;
    const submit = async (steps: unknown[]) => {
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      try {
        expect((await c.hello(token)).t).toBe('welcome');
        expect((await c.open(1, doc)).t).toBe('ch.opened');
        return await c.submit(1, { id: uuid7(), base: await head(), steps });
      } finally {
        c.close();
      }
    };

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
      doc = await h.createDocument(h.a, documentWithRegions());
      other = await h.createDocument(h.a, documentWithRegions());
      token = await h.mintToken(h.a, 'ann', { [doc]: 'owner', [other]: 'owner' });
      at = posInside(documentWithRegions()['doc'], 'pIntro0000000001') - 1;
    });
    afterAll(async () => {
      await h?.close();
    });

    (skip ? it.skip : it)(
      'refuses an attr step and a replace that name an asset the document does not hold (I4), and leaves the document unchanged',
      async () => {
        const own = await uploaded(doc);
        const foreign = await uploaded(other);
        const figure = (asset: string, id: string) => ({
          type: 'figure',
          attrs: { id, asset, width: 2400, height: 1800 },
        });
        // The control: a figure with the document's own asset is accepted.
        const placed = await submit([
          {
            stepType: 'replace',
            from: at,
            to: at,
            slice: { content: [figure(own, FIGURE_ID)] },
          },
        ]);
        expect(placed.t, JSON.stringify(placed)).toBe('sync.ack');
        const seq = await head();
        const before = await content();

        // `attr`: the asset of the figure that is in the document changes to one it does not hold.
        const attr = await submit([{ stepType: 'attr', pos: at, attr: 'asset', value: foreign }]);
        expect(attr.t, JSON.stringify(attr)).toBe('sync.reject');
        expect(attr.d?.['code']).toBe('invalid_op');
        expect(String(attr.d?.['message'])).toMatch(/I4.*not attached/);

        // `replace`: another figure naming the same foreign asset.
        const replace = await submit([
          {
            stepType: 'replace',
            from: at,
            to: at,
            slice: { content: [figure(foreign, 'fSec027Figure002')] },
          },
        ]);
        expect(replace.t, JSON.stringify(replace)).toBe('sync.reject');
        expect(replace.d?.['code']).toBe('invalid_op');
        expect(String(replace.d?.['message'])).toMatch(/I4.*not attached/);

        // Nothing was stored for any refusal, and the document is the one the control left.
        expect(await head()).toBe(seq);
        expect(await content()).toBe(before);
      },
    );

    (skip ? it.skip : it)(
      'the stored log holds the accepted commit and none of the refused ones',
      async () => {
        const log = await h.parts.logs.read({ tenant: h.a.id, doc }, 1);
        expect(log.length).toBeGreaterThan(0);
        expect(JSON.stringify(log)).not.toContain('fSec027Figure002');
        expect(JSON.stringify(log)).not.toContain('fSec027Figure003');
      },
    );
  });
}
