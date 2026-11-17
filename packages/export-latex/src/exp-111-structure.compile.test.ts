/**
 * EXP-111 criteria 2, 3, 5 and 6, checked on compiled PDFs (Node.js only; lane w2). The documents
 * compile in the export worker's sandbox (Podman, no network) and veraPDF runs in its own image
 * (EXP-016). The structure tree is read with `test/pdf-structure.ts`.
 *
 * - Criterion 2: the corpus documents of FND-006 that are in git (`pages-1`, `form-fields`,
 *   `pages-20`) compile with tagging on and pass veraPDF as PDF/UA-2 and as PDF/A-4f.
 * - Criterion 3: the catalogue's `/Lang` is the document language, and a run with a `lang` mark is
 *   a `Span` whose `/Lang` is the mark's value; no other element carries a language.
 * - Criterion 5: the header, the footer and its page number are marked `/Artifact` in the page
 *   content and no structure element refers to them: the tree of the document with a header and a
 *   footer equals the tree of the same document without them.
 * - Criterion 6: each flattened form field is a `Span` whose alternative text is the field's label
 *   and whose content is the field's value.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { loadDocument } from '@docedit/corpus';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { pdfText, sandboxReady, validatePdf } from '../test/harness.ts';
import { contentStreams, elements, outline, structTree } from '../test/pdf-structure.ts';
import { A4, field, story, taggedPdf } from '../test/tagged-docs.ts';

const ready = (await sandboxReady()).ok;

async function validateCorpusDocument(name: string): Promise<void> {
  const corpus = await loadDocument(name);
  const assets: Record<string, unknown> = {};
  for (const a of corpus.assets)
    assets[a.entry.id] = {
      sha256: a.entry.sha256,
      mediaType: a.entry.mediaType,
      bytes: a.bytes,
    };
  const pdf = await taggedPdf(`exp-111-corpus-${name}`, corpus.envelope, {
    pdfStandard: 'ua-2+a-4f',
    assets,
  });
  expect(structTree(pdf)).not.toBeNull();
  const ua2 = await validatePdf(pdf, 'ua2');
  expect(ua2.error, 'the validator output parses').toBeUndefined();
  expect(ua2.failures, 'no PDF/UA-2 rule fails').toEqual([]);
  expect(ua2.compliant).toBe(true);
  const a4f = await validatePdf(pdf, '4f');
  expect(a4f.error, 'the validator output parses').toBeUndefined();
  expect(a4f.failures, 'no PDF/A-4f rule fails').toEqual([]);
  expect(a4f.compliant).toBe(true);
}

describe.skipIf(!ready)('EXP-111 criterion 2: the corpus passes veraPDF when tagged', () => {
  it.each(['pages-1', 'form-fields'])(
    'validates the corpus document %s as PDF/UA-2 and PDF/A-4f',
    validateCorpusDocument,
    900_000,
  );

  // `pages-20` holds Chinese, Japanese and Korean text, and the worker image has no face for it
  // (EXP-016 Notes): a final export stops on the missing glyphs, so there is no PDF to validate.
  // `it.fails` turns this red once a face is added to the image, which is the cue to move
  // `pages-20` into the list above.
  it.fails(
    'validates the corpus document pages-20 (blocked: the image has no CJK face)',
    () => validateCorpusDocument('pages-20'),
    900_000,
  );
});

describe.skipIf(!ready)('EXP-111 criterion 3: the language of the document and of passages', () => {
  it('sets the document language on the catalogue and the mark’s language on its passage only', async () => {
    const french = {
      type: 'text',
      text: 'Bonjour le monde.',
      marks: [{ type: 'lang', attrs: { value: 'fr-FR' } }],
    };
    const german = {
      type: 'text',
      text: 'Guten Tag.',
      marks: [{ type: 'lang', attrs: { value: 'de-DE' } }],
    };
    const pdf = await taggedPdf(
      'exp-111-lang-passages',
      doc(
        [
          para('Plain text. ', {}, [french, { type: 'text', text: ' More plain text.' }]),
          para('', {}, [german]),
          para('A last plain paragraph.'),
        ],
        { settings: { lang: 'en-GB' } },
      ),
    );
    const tree = structTree(pdf);
    if (!tree) throw new Error('the PDF has no structure tree');
    expect(tree.lang).toBe('en-GB');
    const withLang = elements(tree.root).filter((n) => n.lang !== undefined);
    expect(
      withLang.map((n) => [n.role, n.lang]),
      outline(tree.root),
    ).toEqual([
      ['Span', 'fr-FR'],
      ['Span', 'de-DE'],
    ]);
    // Each passage has content of its own, and the plain text around it stays in the paragraph.
    for (const span of withLang) expect(span.mcids.length).toBeGreaterThan(0);
    const paragraphs = elements(tree.root).filter((n) => n.role === 'P');
    expect(paragraphs[0]!.mcids.length).toBe(2);
    const ua2 = await validatePdf(pdf, 'ua2');
    expect(ua2.failures).toEqual([]);
    expect(ua2.compliant).toBe(true);
  }, 600_000);

  it('takes the document language from the settings', async () => {
    const pdf = await taggedPdf(
      'exp-111-lang-de',
      doc([para('Hallo Welt.')], { settings: { lang: 'de-DE' } }),
    );
    expect(structTree(pdf)?.lang).toBe('de-DE');
  }, 600_000);
});

describe.skipIf(!ready)(
  'EXP-111 criterion 5: headers, footers and page numbers are outside the reading order',
  () => {
    const body = (): J[] => [
      para('BODYONE first page.'),
      para('BODYTWO second page.', { pageBreakBefore: true }),
    ];
    const withFurniture = () =>
      doc(body(), {
        pageSetups: [
          {
            type: 'page_setup',
            attrs: { id: 'ps1', ...A4, headerDefault: 'h1', footerDefault: 'f1' },
          },
        ],
        stories: [
          story('h1', [para('RUNNINGHEAD')]),
          story('f1', [para('FOOTPAGE ', {}, [field('page')])]),
        ],
      });
    const plain = () =>
      doc(body(), { pageSetups: [{ type: 'page_setup', attrs: { id: 'ps1', ...A4 } }] });

    /** Whether every piece of marked content of the stream is an artifact or has an MCID. */
    const marks = (stream: string) => ({
      artifacts: (stream.match(/\/Artifact\s*(<<[^>]*>>\s*)?(BMC|BDC)/g) ?? []).length,
      tagged: (stream.match(/<<\s*\/MCID \d+\s*>>\s*BDC/g) ?? []).length,
    });

    it('prints them on every page, marks them as artifacts and keeps them out of the tree', async () => {
      const pdf = await taggedPdf('exp-111-furniture', withFurniture());
      const bare = await taggedPdf('exp-111-no-furniture', plain());

      // The header and the footer are on both pages, with the page's own number.
      const text = pdfText(pdf);
      if (text === null) throw new Error('pdftotext is not installed or failed');
      const pages = text.split('\f').filter((p) => p.trim() !== '');
      expect(pages).toHaveLength(2);
      pages.forEach((page, i) => {
        expect(page).toContain('RUNNINGHEAD');
        expect(page.replace(/\s+/g, '')).toContain(`FOOTPAGE${i + 1}`);
      });
      expect(pdfText(bare)).not.toContain('RUNNINGHEAD');

      // The structure tree is the tree of the document without them: same elements, same number
      // of marked-content references. The header and footer text therefore has no element.
      const tree = structTree(pdf);
      const bareTree = structTree(bare);
      if (!tree || !bareTree) throw new Error('a PDF has no structure tree');
      expect(outline(tree.root)).toBe(outline(bareTree.root));
      expect(tree.mcidCount).toBe(bareTree.mcidCount);
      expect(elements(tree.root).filter((n) => n.role === 'P')).toHaveLength(2);

      // In the page content, the tagged pieces are the same in number, and the header and the
      // footer add artifacts only.
      const streams = contentStreams(pdf)
        .map(marks)
        .filter((m) => m.tagged > 0);
      const bareStreams = contentStreams(bare)
        .map(marks)
        .filter((m) => m.tagged > 0);
      expect(streams).toHaveLength(2);
      expect(streams.map((m) => m.tagged)).toEqual(bareStreams.map((m) => m.tagged));
      streams.forEach((m, i) => expect(m.artifacts).toBeGreaterThan(bareStreams[i]!.artifacts));
      expect(tree.mcidCount).toBe(streams.reduce((n, m) => n + m.tagged, 0));

      // veraPDF's PDF/UA-2 profile fails content that is neither tagged nor an artifact.
      const ua2 = await validatePdf(pdf, 'ua2');
      expect(ua2.failures).toEqual([]);
      expect(ua2.compliant).toBe(true);
    }, 900_000);
  },
);

describe.skipIf(!ready)(
  'EXP-111 criterion 6: a flattened field value is tagged with its label',
  () => {
    const formField = (key: string, label: string, value: string | null): J => ({
      type: 'form_field',
      attrs: { id: nid('ff'), key, kind: 'text', label, width: 2880, value },
    });

    it('makes each field a span with the label as alternative text and the value as content', async () => {
      const fields = (first: string | null) =>
        doc([
          para('Name: ', {}, [
            formField('name', 'Customer name', first),
            { type: 'text', text: ' Town: ' },
            formField('town', 'Town of residence', 'LONDONVALUE'),
          ]),
        ]);
      const pdf = await taggedPdf('exp-111-fields', fields('ADAVALUE'));
      expect(pdfText(pdf)).toContain('ADAVALUE');
      const tree = structTree(pdf);
      if (!tree) throw new Error('the PDF has no structure tree');
      const spans = elements(tree.root).filter((n) => n.alt !== undefined);
      expect(
        spans.map((n) => [n.role, n.alt]),
        outline(tree.root),
      ).toEqual([
        ['Span', 'Customer name'],
        ['Span', 'Town of residence'],
      ]);
      // The value is the span's own marked content, not the paragraph's.
      for (const span of spans) expect(span.mcids).toHaveLength(1);
      const paragraph = elements(tree.root).find((n) => n.role === 'P')!;
      expect(paragraph.kids.filter((k) => k.alt !== undefined)).toHaveLength(2);

      // With the first value empty the paragraph's own content is unchanged: the value was in the
      // span. The empty field keeps its span and label.
      const empty = structTree(await taggedPdf('exp-111-fields-empty', fields(null)));
      if (!empty) throw new Error('the PDF has no structure tree');
      const emptyParagraph = elements(empty.root).find((n) => n.role === 'P')!;
      expect(emptyParagraph.mcids.length).toBe(paragraph.mcids.length);
      expect(
        elements(empty.root)
          .filter((n) => n.alt !== undefined)
          .map((n) => n.alt),
      ).toEqual(['Customer name', 'Town of residence']);

      const ua2 = await validatePdf(pdf, 'ua2');
      expect(ua2.failures).toEqual([]);
      expect(ua2.compliant).toBe(true);
    }, 900_000);
  },
);
