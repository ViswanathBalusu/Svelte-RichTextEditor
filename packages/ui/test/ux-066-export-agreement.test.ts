/**
 * UX-066 criterion 3 and UX-067 criterion 5 (Node.js only). The accessibility checker and the LaTeX
 * export job (EXP-113, read through `altTextReport`) list the pictures without alternative text
 * from the same CDM envelope, so they agree on which pictures lack it (09 section 13). The
 * envelope covers the body, a figure with a caption picture, a table cell, a footnote, a header
 * (a story) and the two alternative-text forms that count as missing (absent and blank).
 *
 * UX-067 criterion 5: issues the checker lists do not block the export job. A document with
 * unlisted pictures still converts with `ok` true, and the job reports each one as a warning.
 *
 * The envelope helpers come from the export package's test helpers; nothing here compiles a PDF.
 */
import { describe, expect, it } from 'vitest';
import { bundleAltTextReport } from '../../export-latex/src/alt-report.ts';
import { doc, nid, para, run, type J } from '../../export-latex/test/docs.ts';
import { checkDocument } from '../src/shell/accessibility-check.ts';
import { checkViewOfContent } from '../src/shell/accessibility-content.ts';

const PNG_SHA = 'c'.repeat(64);
const ASSETS = {
  pic1: {
    sha256: PNG_SHA,
    mediaType: 'image/png',
    status: 'ready' as const,
    bytes: new Uint8Array([137, 80, 78, 71]),
  },
};

function picture(alt: string | undefined): J {
  return {
    type: 'image',
    attrs: { asset: 'pic1', width: 720, height: 720, ...(alt === undefined ? {} : { alt }) },
  };
}

function figure(alt: string | undefined, caption: J[] = []): J {
  return {
    type: 'figure',
    attrs: {
      id: nid('f'),
      asset: 'pic1',
      width: 1440,
      height: 1440,
      ...(alt === undefined ? {} : { alt }),
    },
    content: caption.length ? [{ type: 'caption', attrs: { id: nid('c') }, content: caption }] : [],
  };
}

/** A paragraph with a text run and the given inline nodes. */
function inlinePara(...inline: J[]): J {
  return {
    type: 'paragraph',
    attrs: { id: nid('p') },
    content: [{ type: 'text', text: 'See ' }, ...inline],
  };
}

/** The document: every place a picture can sit, with a mix of present, absent and blank alt text. */
function mixed(): ReturnType<typeof doc> {
  const cellTable: J = {
    type: 'table',
    attrs: { id: nid('t') },
    content: [
      {
        type: 'table_row',
        attrs: { id: nid('r') },
        content: [
          {
            type: 'table_cell',
            attrs: { id: nid('c') },
            content: [inlinePara(picture(undefined))],
          },
        ],
      },
    ],
  };
  const footnote: J = {
    type: 'footnote',
    attrs: { id: nid('fn') },
    content: [
      {
        type: 'paragraph',
        attrs: { id: nid('p') },
        content: [{ type: 'text', text: 'Note.' }, picture(undefined)],
      },
    ],
  };
  const header: J = {
    type: 'story',
    attrs: { id: nid('s') },
    content: [inlinePara(picture(undefined))],
  };
  const body: J[] = [
    figure(undefined),
    inlinePara(picture(undefined)),
    para('Plain paragraph.'),
    figure('A chart', [picture(undefined)]),
    cellTable,
    inlinePara(footnote),
    inlinePara(picture('   ')),
    inlinePara(picture('A diagram')),
  ];
  return doc(body, { stories: [header] });
}

describe('UX-066 criterion 3: the checker and the export job agree on the pictures without alternative text', () => {
  it('lists the same blocks as the export job report, for body, caption, cell, footnote and header pictures', async () => {
    const env = mixed();
    const bundle = await run(env, { assets: ASSETS });
    const exported = bundleAltTextReport(bundle)
      .blockIds.filter((id): id is string => id !== null)
      .sort();
    const report = checkDocument(checkViewOfContent(env).blocks);
    const checked = (report.groups.find((g) => g.kind === 'alt-text')?.issues ?? [])
      .map((issue) => issue.blockId)
      .sort();
    // Five pictures lack alternative text in the body and its cell and footnote, the caption, and
    // the header; the figure with alt text and the two with alt text are not listed. The count is
    // seven: figure, body picture, caption picture, cell picture, footnote picture, blank picture
    // and header picture.
    expect(exported).toHaveLength(7);
    expect(checked).toEqual(exported);
  });

  it('counts the same pictures for a document with no header and no footnote', async () => {
    const env = doc([
      figure(undefined),
      inlinePara(picture(undefined)),
      inlinePara(picture('Described')),
    ]);
    const bundle = await run(env, { assets: ASSETS });
    const exported = bundleAltTextReport(bundle).blockIds;
    const checked = (
      checkDocument(checkViewOfContent(env).blocks).groups.find((g) => g.kind === 'alt-text')
        ?.issues ?? []
    ).map((i) => i.blockId);
    expect(exported).toHaveLength(2);
    expect([...checked].sort()).toEqual([...exported].sort());
  });
});

describe('UX-067 criterion 5: issues the checker lists do not block the export', () => {
  it('converts with ok true and reports each unlisted picture as a warning', async () => {
    const env = doc([figure(undefined), inlinePara(picture(undefined))]);
    const listed = checkDocument(checkViewOfContent(env).blocks);
    expect(listed.count).toBeGreaterThan(0);
    const bundle = await run(env, { assets: ASSETS });
    expect(bundle.ok).toBe(true);
    const missing = bundle.diagnostics.filter((d) => d.code === 'image_without_alt');
    expect(missing).toHaveLength(2);
    expect(missing.every((d) => d.severity === 'warning')).toBe(true);
  });
});
