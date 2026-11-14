/**
 * EXP-116, third criterion, the writer's side: identity-bound attributes of a preserved tree are
 * taken out at import and kept in the source map (`identityTree`), and the writer puts them back.
 * A property test (fast-check, fixed seed) checks the round trip on random trees, and the corpus
 * file cr043-tracked.docx (two revision-session values in a paragraph's section properties) checks
 * that the document holds none of them while a regenerated paragraph writes them back.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkR1,
  everyParagraph,
  exportDocx,
  importDocx,
  readZip,
  entryData,
} from '../src/index.ts';
import { IDENTITY_ATTRS } from '../src/ooxml.ts';
import { type TreeBody, type TreeNode, restoreIdentity, splitIdentity } from '../src/tree.ts';
import { corpusFiles, readFile } from './corpus.ts';

const IDENTITY = [...IDENTITY_ATTRS];
const PLAIN = ['w:val', 'w:ascii', 'w:fill', 'w:color'];
const NAMES = ['w:sectPr', 'w:pgSz', 'w:sectPrChange', 'w:rFonts', 'w:shd'];

const attrBag = fc.dictionary(
  fc.constantFrom(...IDENTITY, ...PLAIN),
  fc.stringMatching(/^[0-9A-F]{8}$/),
  { maxKeys: 3 },
);

const treeNode = (depth: number): fc.Arbitrary<TreeNode> =>
  depth <= 0
    ? fc.record({
        name: fc.constantFrom(...NAMES),
        attrs: attrBag,
      })
    : fc.oneof(
        fc.record({ text: fc.constantFrom('a', 'b') }),
        fc.record({
          name: fc.constantFrom(...NAMES),
          attrs: attrBag,
          children: fc.array(treeNode(depth - 1), { maxLength: 3 }),
        }),
      );

const bodyArb: fc.Arbitrary<TreeBody> = fc.record({
  attrs: fc.dictionary(fc.constantFrom('w:val', 'w:fill'), fc.constant('1'), { maxKeys: 1 }),
  children: fc.array(treeNode(2), { maxLength: 4 }),
});

/** Sorts attribute names, so that two trees compare equal when only their attribute order differs. */
const normal = (n: unknown): string =>
  JSON.stringify(n, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

const hasIdentity = (nodes: readonly TreeNode[] | undefined): boolean =>
  (nodes ?? []).some(
    (n) =>
      !('text' in n) &&
      (Object.keys(n.attrs ?? {}).some((k) => IDENTITY_ATTRS.has(k)) || hasIdentity(n.children)),
  );

describe('EXP-116: identity-bound attributes are split out and put back', () => {
  it('removes every identity attribute from the body and restores it exactly (fixed seed)', () => {
    fc.assert(
      fc.property(bodyArb, (body) => {
        const original = normal(body);
        const working = JSON.parse(original) as TreeBody;
        const entries = splitIdentity(working, IDENTITY_ATTRS);
        expect(hasIdentity(working.children)).toBe(false);
        const restored = restoreIdentity(working, entries);
        expect(normal(restored)).toBe(original);
        // The split does not change the body it was given to restore from.
        if (entries.length) expect(normal(working)).not.toBe(original);
      }),
      { seed: 116, numRuns: 300 },
    );
  });

  it('returns the body unchanged when there is nothing to restore', () => {
    const body: TreeBody = { children: [{ name: 'w:shd', attrs: { 'w:fill': '1' } }] };
    expect(restoreIdentity(body, undefined)).toBe(body);
    expect(restoreIdentity(body, [])).toBe(body);
  });

  it('keeps the revision-session values of cr043-tracked.docx out of the document and writes them back', async () => {
    const file = corpusFiles().find((f) => f.name === 'docx4j/cr043-tracked.docx')!;
    const bytes = readFile(file);
    const imported = await importDocx(bytes);
    const json = JSON.stringify(imported.envelope);
    expect(json).not.toContain('009D091E');
    expect(json).not.toContain('005B485E');
    const edit = everyParagraph(imported.envelope, imported.sourceMap);
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets, {
      regenerate: new Set(edit.edited),
    });
    const zip = readZip(out.bytes);
    const doc = new TextDecoder().decode(entryData(zip, zip.byName.get('word/document.xml')!));
    expect(doc).toContain('w:rsidSect="005B485E"');
    expect(doc).toContain('w:rsidR="009D091E"');
    expect(checkR1(bytes, out.bytes, imported.sourceMap, edit).violations).toEqual([]);
  });
});
