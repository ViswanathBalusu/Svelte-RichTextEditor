/**
 * SEC-006 criteria 2 and 4 (10 §3.1 hostile images and dangerous links; I9).
 *
 * Criterion 2, the attribute half: an image whose `asset` is a `data:` URL is refused over the wire
 * and never stored inline (the CDM names assets by identifier; "never embedded data"). The pasted
 * content half needs the browser and the paste cleaners, so it is not run here.
 *
 * Criterion 4, the LaTeX half: the LaTeX writer's `url` emitter takes only http, https, mailto and
 * in-document targets, and never emits an external link for any other scheme. The DOCX writer is
 * not covered here: its hyperlink path does not check the scheme itself (see the story Notes).
 */
import fc from 'fast-check';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { Fragment, inside, loadDoc, schema, Slice, stepsJson } from './support/cdm.ts';
import { WireClient } from './support/wire.ts';
import { url } from '../../../packages/export-latex/src/emit.ts';

/** `data:` URLs that an image attribute must never accept. */
const DATA_URLS = [
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'data:image/svg+xml,<svg onload="alert(1)"/>',
  'DATA:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'data:,x',
];

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-006 data URLs are not accepted as images (${storage})`, () => {
    let h: Harness;
    let doc: string;
    beforeAll(async () => {
      if (!skip) {
        h = await startHarness(storage);
        doc = await h.createDocument(h.a, documentWithRegions());
      }
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    const content = async () =>
      (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })).json as {
        seq: number;
        doc: unknown;
      };

    /** An inline image whose asset attribute is `asset`, inserted in the introduction. */
    async function imageCommit(c: WireClient, asset: string) {
      const cur = await content();
      const pos = inside(loadDoc(cur.doc), 'pIntro0000000001');
      const picture = schema.nodes['image']!.create({ asset, width: 1000, height: 1000 });
      return c.submit(1, {
        id: uuid7(),
        base: cur.seq,
        steps: stepsJson([new ReplaceStep(pos, pos, new Slice(Fragment.from(picture), 0, 0))]),
      });
    }

    t()('control: an image naming an asset identifier is accepted', async () => {
      const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      await c.hello(token);
      await c.open(1, doc);
      try {
        const r = await imageCommit(c, uuid7());
        // The refusals below are about the data URL form, not about images in general.
        expect(r.t).toBe('sync.ack');
      } finally {
        c.terminate();
      }
    });

    t()('refuses a data URL in the asset attribute and stores nothing inline', async () => {
      const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      await c.hello(token);
      await c.open(1, doc);
      try {
        const before = (await content()).seq;
        for (const asset of DATA_URLS) {
          const r = await imageCommit(c, asset);
          expect(r.t, `${asset.slice(0, 30)} is refused`).toBe('sync.reject');
          expect(r.d?.['code']).toBe('invalid_op');
        }
        const after = await content();
        expect(after.seq).toBe(before);
        expect(JSON.stringify(after.doc)).not.toContain('data:');
      } finally {
        c.terminate();
      }
    });

    t()(
      'property: any data URL body in the asset attribute is refused and never stored',
      async () => {
        const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
        const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        await c.hello(token);
        await c.open(1, doc);
        try {
          const body = fc.stringMatching(/^[A-Za-z0-9+/=;,:._-]{0,40}$/);
          await fc.assert(
            fc.asyncProperty(body, async (rest) => {
              const r = await imageCommit(c, `data:image/png;base64,${rest}`);
              expect(r.t).toBe('sync.reject');
            }),
            { numRuns: 25 },
          );
          expect(JSON.stringify((await content()).doc)).not.toContain('data:image');
        } finally {
          c.terminate();
        }
      },
      120_000,
    );
  });
}

// Criterion 4, the LaTeX writer: only the four accepted target forms yield an external link.
describe('SEC-006 LaTeX link targets follow the allow-list (I9)', () => {
  it('property: an external link is emitted only for http, https or mailto', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (href) => {
        const r = url(href);
        if (r.kind === 'external') {
          expect(/^(?:https?:\/\/|mailto:)/i.test(href)).toBe(true);
        }
        if (r.kind === 'refused') {
          expect('tex' in r).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('refuses each scheme of SEC-006 criterion 4 and never writes its text', () => {
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,x',
      'vbscript:x',
      'file:///etc/passwd',
      'blob:x',
    ]) {
      const r = url(href);
      expect(r.kind, href).toBe('refused');
    }
  });
});
