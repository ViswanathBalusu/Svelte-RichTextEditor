/**
 * EXP-091, criterion 2 (lane export-docx-2, round 6): a figure with `width`, `height`, `align` and
 * `alt` is written as a picture at those sizes, with its alternative text, in a paragraph aligned as
 * `align` says. Drawn by fast-check at a fixed seed. Sizes are twips in the model; a picture's extent
 * is in EMU, 635 EMU to the twip. The alignment rule is the one in `figureXml`: `center` gives
 * `center`, `end` gives `right`, `start` gives `left`, and any other value gives no justification.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { newDocument, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { AssetStore, entryData, parseXml, readZip, type XmlElement } from '../src/index.ts';
import { NS } from '../src/ooxml.ts';
import { writeDocx } from '../src/writer.ts';
import { PNG } from './writer-docs.ts';

const SEED = 20261113;
const RUNS = 30;
const EMU_PER_TWIP = 635;

const ALIGN_TO_JC: Record<string, string | null> = {
  center: 'center',
  end: 'right',
  start: 'left',
  justify: null,
};

function all(root: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const stack: XmlElement[] = [root];
  while (stack.length) {
    const e = stack.pop()!;
    if (e.local === local) out.push(e);
    for (let i = e.children.length - 1; i >= 0; i--) {
      const c = e.children[i]!;
      if (c.kind === 'element') stack.push(c);
    }
  }
  return out;
}

const val = (e: XmlElement | undefined, local: string): string | undefined =>
  e?.attrs.find((a) => a.ns === NS.w && a.local === local)?.value;

function figureDocument(
  asset: string,
  figure: { width: number; height: number; alt: string; align: string },
): JsonEnvelope {
  const env = newDocument({ lang: 'en-GB' });
  const body = env.doc.content!.find((n) => n.type === 'body')!;
  const node: JsonNode = {
    type: 'figure',
    attrs: { id: 'fz000000000000001', asset, ...figure },
    content: [],
  };
  body.content = [node];
  return env;
}

describe('EXP-091 criterion 2: a figure is written at its size, with its alt text and its alignment', () => {
  it('for any size, alignment and alternative text, the picture extent, docPr descr and paragraph jc follow the model', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 9000 }),
        fc.integer({ min: 1, max: 9000 }),
        fc.constantFrom('center', 'end', 'start', 'justify', 'other'),
        fc.string({ maxLength: 40 }).map((s) =>
          Array.from(s, (c) => {
            const code = c.charCodeAt(0);
            return code < 0x20 || (code >= 0xd800 && code <= 0xdfff) ? '?' : c;
          }).join(''),
        ),
        async (width, height, align, alt) => {
          const assets = new AssetStore();
          const png = await assets.add(PNG, 'image/png', 'image');
          const out = await writeDocx(figureDocument(png, { width, height, alt, align }), assets);
          const zip = readZip(out.bytes);
          const doc = parseXml(entryData(zip, zip.byName.get('word/document.xml')!)).root;

          const extents = all(doc, 'extent');
          expect(extents.length).toBe(1);
          expect(Number(extents[0]!.attrs.find((a) => a.local === 'cx')?.value)).toBe(
            width * EMU_PER_TWIP,
          );
          expect(Number(extents[0]!.attrs.find((a) => a.local === 'cy')?.value)).toBe(
            height * EMU_PER_TWIP,
          );

          const docPr = all(doc, 'docPr')[0]!;
          // An empty alternative text is no alternative text: the writer leaves `descr` out.
          expect(docPr.attrs.find((a) => a.local === 'descr')?.value).toBe(alt || undefined);

          const paragraph = all(doc, 'p').find((p) => all(p, 'drawing').length > 0)!;
          const jc = val(all(paragraph, 'jc')[0], 'val');
          const expected = ALIGN_TO_JC[align] ?? null;
          expect(jc).toBe(expected ?? undefined);
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
  });
});
