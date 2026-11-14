/**
 * EXP-113 (Node.js only): the export reports each picture without alternative text with its block
 * identifier and a count, and the preflight (EXP-003) and the job report the same pictures.
 * Criteria covered here: 1 (each `image` and `figure` without `alt`, with its block), 3 (the
 * preflight and the job agree), and the count of criterion 2 when read from a bundle's
 * diagnostics. Criterion 2 as a field of the job's result object, and criterion 4 (the editor's
 * checker), are not covered here: see the story's Notes. The documents come from `test/docs.ts`;
 * nothing here compiles.
 */
import { describe, expect, it } from 'vitest';
import { FONTS, doc, nid, para, run, type J } from '../test/docs.ts';
import { altTextReport, bundleAltTextReport, IMAGE_WITHOUT_ALT } from './alt-report.ts';
import { preflight } from './preflight.ts';

const PNG_SHA = 'c'.repeat(64);
const ASSETS = {
  pic1: {
    sha256: PNG_SHA,
    mediaType: 'image/png',
    status: 'ready' as const,
    bytes: new Uint8Array([137, 80, 78, 71]),
  },
};

function figure(alt: string | undefined): J {
  return {
    type: 'figure',
    attrs: {
      id: nid('f'),
      asset: 'pic1',
      width: 1440,
      height: 1440,
      ...(alt === undefined ? {} : { alt }),
    },
  };
}

/** A paragraph with one inline picture, which has the given alternative text or none. */
function inlinePicture(alt: string | undefined): J {
  const id = nid('p');
  const image: J = {
    type: 'image',
    attrs: { asset: 'pic1', width: 720, height: 720, ...(alt === undefined ? {} : { alt }) },
  };
  return { type: 'paragraph', attrs: { id }, content: [{ type: 'text', text: 'See ' }, image] };
}

/** A document with pictures in the body, a table cell, a footnote and a figure with alt text. */
function mixed(): ReturnType<typeof doc> {
  const cellPara = inlinePicture(undefined);
  const table: J = {
    type: 'table',
    attrs: { id: nid('t') },
    content: [
      {
        type: 'table_row',
        attrs: { id: nid('r') },
        content: [{ type: 'table_cell', attrs: { id: nid('c') }, content: [cellPara] }],
      },
    ],
  };
  const footnoteId = nid('fn');
  const notePara: J = {
    type: 'paragraph',
    attrs: { id: nid('p') },
    content: [
      { type: 'text', text: 'Note.' },
      { type: 'image', attrs: { asset: 'pic1', width: 360, height: 360 } },
    ],
  };
  const withFootnote: J = {
    type: 'paragraph',
    attrs: { id: nid('p') },
    content: [
      { type: 'text', text: 'Text' },
      { type: 'footnote', attrs: { id: footnoteId }, content: [notePara] },
    ],
  };
  return doc([
    figure(undefined),
    inlinePicture(undefined),
    para('Plain paragraph.'),
    figure('A chart'),
    table,
    withFootnote,
    inlinePicture('   '),
    inlinePicture('A diagram'),
  ]);
}

describe('EXP-113 criterion 1: each picture without alternative text is reported with its block', () => {
  it('reports a figure without alt, and an inline picture with its paragraph, and nothing with alt text', async () => {
    const env = doc([
      figure(undefined),
      figure('Described'),
      inlinePicture(undefined),
      inlinePicture('Described too'),
    ]);
    const bundle = await run(env, { assets: ASSETS });
    const report = bundleAltTextReport(bundle);
    expect(report.count).toBe(2);
    const body = (env.doc as unknown as { content: J[] }).content.find((c) => c.type === 'body')!;
    const [fig1, fig2, para1, para2] = body.content as J[];
    expect(report.blockIds).toEqual([(fig1!.attrs as J)['id'], (para1!.attrs as J)['id']]);
    expect(report.blockIds).not.toContain((fig2!.attrs as J)['id']);
    expect(report.blockIds).not.toContain((para2!.attrs as J)['id']);
  });

  it('counts a whitespace-only alternative text as none, as the preflight does', async () => {
    const env = doc([inlinePicture('   ')]);
    const report = bundleAltTextReport(await run(env, { assets: ASSETS }));
    expect(report.count).toBe(1);
  });

  it('reports pictures in table cells, footnotes and figures in the same way', async () => {
    const env = mixed();
    const bundle = await run(env, { assets: ASSETS });
    const report = bundleAltTextReport(bundle);
    // Body: figure (no alt), inline picture (no alt), the table cell's picture, the footnote's
    // picture, the blank-alt picture. The figure and the picture with alt text are not reported.
    expect(report.count).toBe(5);
    expect(report.blockIds.every((id) => typeof id === 'string')).toBe(true);
    expect(new Set(report.blockIds).size).toBe(report.blockIds.length);
  });

  it('gives a count of zero and no entries for a document whose pictures all have alternative text', async () => {
    const bundle = await run(doc([figure('One'), inlinePicture('Two')]), { assets: ASSETS });
    expect(bundleAltTextReport(bundle)).toMatchObject({ count: 0, blockIds: [] });
  });

  it('reports the warning as a warning, so that a final export is not blocked by it', async () => {
    const bundle = await run(doc([figure(undefined)]), { assets: ASSETS });
    const found = bundle.diagnostics.filter((d) => d.code === IMAGE_WITHOUT_ALT);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('warning');
    expect(bundle.ok).toBe(true);
  });
});

describe('EXP-113 criterion 3: the preflight and the job report the same pictures', () => {
  it('gives the same block identifiers, in the same order, for the same document', async () => {
    const env = mixed();
    const fromPreflight = preflight(env, FONTS)
      .filter((w) => w.code === 'image_without_alt')
      .map((w) => w.blockId);
    const fromJob = bundleAltTextReport(await run(env, { assets: ASSETS })).blockIds;
    expect(fromJob).toEqual(fromPreflight);
    expect(fromJob.length).toBe(5);
  });
});

describe('EXP-113 the report of diagnostics', () => {
  it('reads only the picture codes of a list of diagnostics', () => {
    const report = altTextReport([
      { severity: 'warning', code: IMAGE_WITHOUT_ALT, blockId: 'a', message: 'x' },
      { severity: 'error', code: 'glyph_missing', blockId: 'b', message: 'y' },
      { severity: 'warning', code: IMAGE_WITHOUT_ALT, blockId: null, message: 'z' },
    ]);
    expect(report.count).toBe(2);
    expect(report.blockIds).toEqual(['a', null]);
  });
});
