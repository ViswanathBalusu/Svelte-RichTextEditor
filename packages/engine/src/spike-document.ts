/**
 * The document spike S1 edits: the example of 03 §12 extended with a header story, a footnote and a
 * field, so that definitions, stories, regions, footnotes and fields are all present. Identifiers
 * are fixed so that tests can address blocks by them. The footnote holds one paragraph (CDM-001
 * option B); the argument is kept for callers written for the spike and is ignored.
 */
import type { CdmEnvelope } from './api.ts';
import type { FootnoteModel } from './schema.ts';

const id = (prefix: string, n = 1): string => prefix + String(n).padStart(16 - prefix.length, '0');

export const SPIKE_IDS = {
  header: id('stHeader'),
  headerParagraph: id('pHeader'),
  title: id('pTitle'),
  intro: id('pIntro'),
  footnote: id('fnOne'),
  footnoteParagraph: id('pNote'),
  region: id('rLegal'),
  legal: id('pLegal'),
  after: id('pAfter'),
  last: id('pLast'),
} as const;

const text = (t: string, marks?: unknown[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };

export function spikeDocument(_model?: FootnoteModel): CdmEnvelope {
  const footnote = {
    type: 'footnote',
    attrs: { id: SPIKE_IDS.footnote },
    content: [
      {
        type: 'paragraph',
        attrs: { id: SPIKE_IDS.footnoteParagraph },
        content: [text('Footnote text')],
      },
    ],
  };
  return {
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
              attrs: {
                id: 'Normal',
                kind: 'paragraph',
                name: 'Normal',
                builtIn: true,
                fontSize: 220,
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
                next: 'Normal',
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
                headerDefault: SPIKE_IDS.header,
              },
            },
          ],
        },
        {
          type: 'story',
          attrs: { id: SPIKE_IDS.header, kind: 'header' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: SPIKE_IDS.headerParagraph },
              content: [
                text('Header text '),
                { type: 'field', attrs: { kind: 'page', cached: '1' } },
              ],
            },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: SPIKE_IDS.title, style: 'Heading1' },
              content: [text('Scope')],
            },
            {
              type: 'paragraph',
              attrs: { id: SPIKE_IDS.intro, style: 'Normal' },
              content: [
                text('Alpha bravo charlie'),
                footnote,
                text(' delta echo, page '),
                { type: 'field', attrs: { kind: 'page', cached: '1' } },
                text('.'),
              ],
            },
            {
              type: 'region',
              attrs: { id: SPIKE_IDS.region, title: 'Legal review', policy: 'restricted' },
              content: [
                {
                  type: 'paragraph',
                  attrs: { id: SPIKE_IDS.legal, style: 'Normal' },
                  content: [
                    text('Liability is limited to '),
                    text('direct', [{ type: 'bold', attrs: { value: true } }]),
                    text(' damages.'),
                  ],
                },
              ],
            },
            {
              type: 'paragraph',
              attrs: { id: SPIKE_IDS.after, style: 'Normal' },
              content: [text('Remote target paragraph.')],
            },
            {
              type: 'paragraph',
              attrs: { id: SPIKE_IDS.last, style: 'Normal' },
              content: [text('Last paragraph.')],
            },
          ],
        },
      ],
    },
  };
}
