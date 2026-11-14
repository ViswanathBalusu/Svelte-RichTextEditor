/**
 * Test documents of the export worker (EXP-001): paragraphs in three styles and two regions, the
 * characters TeX treats specially, and a table of contents for the convergence checks.
 */
import type { CdmEnvelope } from '@docedit/model';

/** The characters of EXP-001 criterion 4, typed into one paragraph. */
export const SPECIAL = '\\ { } $ & # _ % ^ ~';

export const REGION_A = 'rTermsAAAAAAAAA1';
export const REGION_B = 'rPriceBBBBBBBBB1';

/** Region titles: regions leave no trace in output (09 §3.1), so neither may appear in the PDF. */
export const REGION_TITLES = ['Zebra crossing review', 'Quokka pricing block'] as const;

export interface TestDocument {
  envelope: CdmEnvelope;
  /** The visible text of the body, paragraph by paragraph, in order. */
  text: string[];
}

const para = (id: string, style: string, text: string) => ({
  type: 'paragraph',
  attrs: { id, style },
  content: [{ type: 'text', text }],
});

/** Three paragraph styles (Title, Heading 1, Normal), two regions, the special characters. */
export function demoDocument(): TestDocument {
  const text = [
    'Export demonstration',
    'Terms of the agreement',
    'The first region holds the terms. Its paragraphs are typeset like any other.',
    'Prices',
    'The second region holds the prices: one hundred and twenty pounds a month.',
    `Special characters typed as they are: ${SPECIAL}`,
    'The end of the document.',
  ];
  const envelope = {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            {
              type: 'settings',
              attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
            },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Title',
                kind: 'paragraph',
                name: 'Title',
                builtIn: true,
                basedOn: 'Normal',
                fontSize: 520,
                bold: true,
              },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Heading1',
                kind: 'paragraph',
                name: 'Heading 1',
                builtIn: true,
                basedOn: 'Normal',
                outlineLevel: 1,
                fontSize: 320,
                bold: true,
              },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 11906,
                height: 16838,
                marginTop: 1440,
                marginRight: 1440,
                marginBottom: 1440,
                marginLeft: 1440,
              },
            },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            para('pTitle0000000001', 'Title', text[0]!),
            {
              type: 'region',
              attrs: { id: REGION_A, title: REGION_TITLES[0], policy: 'restricted' },
              content: [
                para('pTermsHead000001', 'Heading1', text[1]!),
                para('pTermsBody000001', 'Normal', text[2]!),
              ],
            },
            {
              type: 'region',
              attrs: { id: REGION_B, title: REGION_TITLES[1], policy: 'inherit' },
              content: [
                para('pPriceHead000001', 'Heading1', text[3]!),
                para('pPriceBody000001', 'Normal', text[4]!),
              ],
            },
            para('pSpecial00000001', 'Normal', text[5]!),
            para('pEnd000000000001', 'Normal', text[6]!),
          ],
        },
      ],
    },
  } as unknown as CdmEnvelope;
  return { envelope, text };
}

/** A document with a table of contents and enough headings to fill two pages. */
export function tocDocument(sections = 30): CdmEnvelope {
  const doc = demoDocument().envelope as unknown as {
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  const body = doc.doc.content[1]!;
  const blocks: unknown[] = [
    { type: 'toc', attrs: { id: 'tToc000000000001', minLevel: 1, maxLevel: 1 } },
  ];
  for (let i = 1; i <= sections; i++) {
    const n = String(i).padStart(3, '0');
    blocks.push(para(`pHead${n}000000000`.slice(0, 16), 'Heading1', `Section ${i}`));
    blocks.push(
      para(
        `pBody${n}000000000`.slice(0, 16),
        'Normal',
        `Paragraph ${i} of the document, long enough to take a few lines on the page. `.repeat(6),
      ),
    );
  }
  body.content = blocks;
  return doc as unknown as CdmEnvelope;
}
