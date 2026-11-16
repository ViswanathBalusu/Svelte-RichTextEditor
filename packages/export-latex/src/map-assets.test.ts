/**
 * Source map and image tests (Node.js only): EXP-012 (map.json maps lines of main.tex to blocks)
 * and EXP-014 (images enter the bundle by content hash). Documents come from `test/docs.ts`.
 */
import { describe, expect, it } from 'vitest';
import { blockLines, codes, doc, nid, para, run } from '../test/docs.ts';

/** The line numbers (1-based) of main.tex that contain a text. */
function linesWith(main: string, text: string): number[] {
  return main.split('\n').flatMap((l, i) => (l.includes(text) ? [i + 1] : []));
}

/** The block number that map.json gives a line of main.tex, or undefined when no range covers it. */
function blockOfLine(
  map: { lines: Array<{ from: number; to: number; block: number | null }> },
  line: number,
) {
  return map.lines.find((r) => line >= r.from && line <= r.to);
}

const PNG = 'd'.repeat(64);
const PNG_BYTES = new Uint8Array([137, 80, 78, 71]);
const ready = { sha256: PNG, mediaType: 'image/png', status: 'ready' as const, bytes: PNG_BYTES };

describe('EXP-012 map.json maps bundle lines back to blocks', () => {
  it('maps every line range that came from a block to that block identifier', async () => {
    const p1 = nid('p');
    const p2 = nid('p');
    const bundle = await run(
      doc([para('Alpha sentence.', { id: p1 }), para('Beta sentence.', { id: p2 })]),
    );
    expect(bundle.map.blocks[bundle.map.lines.find((r) => r.block !== null)!.block!]).toBeTypeOf(
      'string',
    );
    expect(blockLines(bundle, p1).some((l) => l.includes('Alpha sentence.'))).toBe(true);
    expect(blockLines(bundle, p2).some((l) => l.includes('Beta sentence.'))).toBe(true);
    expect(blockLines(bundle, p1).some((l) => l.includes('Beta sentence.'))).toBe(false);
    for (const r of bundle.map.lines) {
      if (r.block !== null) expect(bundle.map.blocks[r.block]).toBeTypeOf('string');
    }
  });

  it('registers a footnote paragraph as its own block, owned by the footnote', async () => {
    const pid = nid('p');
    const fid = nid('n');
    const fpid = nid('p');
    const bundle = await run(
      doc([
        para('Body text ', { id: pid }, [
          { type: 'footnote', attrs: { id: fid }, content: [para('Note wording.', { id: fpid })] },
        ]),
      ]),
    );
    const k = bundle.map.blocks.indexOf(fpid);
    expect(k).toBeGreaterThan(0);
    expect(bundle.map.kinds[k]).toBe('footnoteParagraph');
    expect(bundle.map.owners[k]).toBe(fid);
  });

  it('maps the lines of a footnote text to the footnote, not to the host paragraph', async () => {
    const pid = nid('p');
    const fid = nid('n');
    const fpid = nid('p');
    const bundle = await run(
      doc([
        para('Body text ', { id: pid }, [
          {
            type: 'footnote',
            attrs: { id: fid },
            content: [
              {
                type: 'paragraph',
                attrs: { id: fpid },
                content: [
                  { type: 'text', text: 'Note wording, ' },
                  { type: 'text', text: 'second run.', marks: [{ type: 'bold' }] },
                ],
              },
            ],
          },
          { type: 'text', text: ' and the tail.' },
        ]),
      ]),
    );
    const main = bundle.files['main.tex']!;
    const k = bundle.map.blocks.indexOf(fpid);
    const noteLines = [...linesWith(main, 'Note wording, '), ...linesWith(main, 'second run.')];
    expect(noteLines.length).toBeGreaterThan(0);
    for (const l of noteLines) {
      expect(blockOfLine(bundle.map, l)?.block).toBe(k);
      expect(bundle.map.owners[blockOfLine(bundle.map, l)!.block!]).toBe(fid);
    }
    // The host's own text, before and after the footnote, stays with the host paragraph.
    const host = bundle.map.blocks.indexOf(pid);
    for (const textOfHost of ['Body text', 'and the tail.']) {
      const at = linesWith(main, textOfHost);
      expect(at.length).toBeGreaterThan(0);
      for (const l of at) expect(blockOfLine(bundle.map, l)?.block).toBe(host);
    }
    expect(blockLines(bundle, pid).some((l) => l.includes('Note wording'))).toBe(false);
  });

  it('maps a footnote text in a table cell to the footnote, not to the cell paragraph or the table', async () => {
    const fid = nid('n');
    const fpid = nid('p');
    const tid = nid('t');
    const bundle = await run(
      doc([
        {
          type: 'table',
          attrs: { id: tid, grid: [2880] },
          content: [
            {
              type: 'table_row',
              attrs: { id: nid('r') },
              content: [
                {
                  type: 'table_cell',
                  attrs: { id: nid('c') },
                  content: [
                    para('Cell text', {}, [
                      {
                        type: 'footnote',
                        attrs: { id: fid },
                        content: [para('Cell note.', { id: fpid })],
                      },
                    ]),
                  ],
                },
              ],
            },
          ],
        },
      ]),
    );
    const main = bundle.files['main.tex']!;
    const at = linesWith(main, 'Cell note.');
    expect(at.length).toBeGreaterThan(0);
    for (const l of at) {
      const b = blockOfLine(bundle.map, l)!.block!;
      expect(bundle.map.blocks[b]).toBe(fpid);
      expect(bundle.map.owners[b]).toBe(fid);
    }
  });

  it('maps a footnote without a paragraph to the footnote identifier itself', async () => {
    const fid = nid('n');
    const bundle = await run(
      doc([
        para('Host ', {}, [
          { type: 'footnote', attrs: { id: fid }, content: [{ type: 'text', text: 'Bare note.' }] },
        ]),
      ]),
    );
    const at = linesWith(bundle.files['main.tex']!, 'Bare note.');
    expect(at.length).toBeGreaterThan(0);
    for (const l of at) expect(bundle.map.blocks[blockOfLine(bundle.map, l)!.block!]).toBe(fid);
  });

  it('maps header and footer paragraphs to blocks owned by their story', async () => {
    const hid = nid('st');
    const fidStory = nid('st');
    const hp = nid('p');
    const fp = nid('p');
    const bundle = await run(
      doc([para('Body.')], {
        pageSetups: [
          {
            type: 'page_setup',
            attrs: { id: 'ps1', headerDefault: hid, footerDefault: fidStory },
          },
        ],
        stories: [
          {
            type: 'story',
            attrs: { id: hid, kind: 'header' },
            content: [para('Running head.', { id: hp })],
          },
          {
            type: 'story',
            attrs: { id: fidStory, kind: 'footer' },
            content: [para('Running foot.', { id: fp })],
          },
        ],
      }),
    );
    const main = bundle.files['main.tex']!;
    for (const [wording, paragraph, story] of [
      ['Running head.', hp, hid],
      ['Running foot.', fp, fidStory],
    ] as const) {
      const at = linesWith(main, wording);
      expect(at.length).toBeGreaterThan(0);
      for (const l of at) {
        const b = blockOfLine(bundle.map, l)!.block!;
        expect(bundle.map.blocks[b]).toBe(paragraph);
        expect(bundle.map.owners[b]).toBe(story);
      }
      // The story's own lines (the opening and closing of its macro) map to the story.
      expect(blockLines(bundle, story).length).toBeGreaterThan(0);
    }
  });

  it('writes no owner mark into any file of the bundle', async () => {
    const bundle = await run(
      doc([
        para('A ', {}, [
          { type: 'footnote', attrs: { id: nid('n') }, content: [para('One.')] },
          { type: 'footnote', attrs: { id: nid('n') }, content: [para('')] },
        ]),
      ]),
    );
    for (const file of Object.values(bundle.files)) {
      expect(file.includes('\u0001')).toBe(false);
      expect(file.includes('\u0002')).toBe(false);
    }
    // Every line of main.tex is covered by exactly one range of map.json.
    const count = bundle.files['main.tex']!.split('\n').length - 1;
    let next = 1;
    for (const r of bundle.map.lines) {
      expect(r.from).toBe(next);
      next = r.to + 1;
    }
    expect(next - 1).toBe(count);
  });

  it('marks lines that belong to no block (preamble and class material) as belonging to no block', async () => {
    const pid = nid('p');
    const bundle = await run(doc([para('Only text.', { id: pid })]));
    const lines = bundle.files['main.tex']!.split('\n');
    const begin = lines.indexOf('\\begin{document}') + 1;
    expect(begin).toBeGreaterThan(0);
    expect(blockOfLine(bundle.map, 1)?.block).toBeNull();
    expect(blockOfLine(bundle.map, begin)?.block).toBeNull();
    const text = linesWith(bundle.files['main.tex']!, 'Only text.')[0]!;
    expect(blockOfLine(bundle.map, text)?.block).toBe(bundle.map.blocks.indexOf(pid));
  });

  it('gives identical map.json for identical input', async () => {
    const env = doc([para('Repeat.'), para('Again.')]);
    const a = await run(structuredClone(env));
    const b = await run(structuredClone(env));
    expect(JSON.stringify(b.map)).toBe(JSON.stringify(a.map));
  });
});

describe('EXP-014 images enter the bundle by content hash', () => {
  it('writes a ready picture to assets/ named by its hash, and refers to it by that name', async () => {
    const f = nid('f');
    const bundle = await run(
      doc([
        { type: 'figure', attrs: { id: f, asset: 'pic', width: 1440, height: 1440, alt: 'Chart' } },
      ]),
      { assets: { pic: ready } },
    );
    expect(Object.keys(bundle.assets)).toEqual([`assets/${PNG}.png`]);
    expect(bundle.assets[`assets/${PNG}.png`]).toEqual(PNG_BYTES);
    expect(bundle.files['main.tex']).toContain(`assets/${PNG}.png`);
    expect(bundle.ok).toBe(true);
  });

  it('reports a figure whose asset is not attached to the document, with its block identifier', async () => {
    const f = nid('f');
    const other = {
      sha256: 'e'.repeat(64),
      mediaType: 'image/png',
      status: 'ready' as const,
      bytes: PNG_BYTES,
    };
    const bundle = await run(
      doc([{ type: 'figure', attrs: { id: f, asset: 'missing', width: 1440, height: 1440 } }]),
      { assets: { unused: other } },
    );
    const d = bundle.diagnostics.find((x) => x.code === 'asset_not_attached');
    expect(d?.blockId).toBe(f);
    // No other asset of the job is read: the unlisted one never reaches the bundle.
    expect(Object.keys(bundle.assets)).toEqual([]);
  });

  it('reports a figure whose asset is not ready, and does not place the file', async () => {
    const f = nid('f');
    const bundle = await run(
      doc([{ type: 'figure', attrs: { id: f, asset: 'pic', width: 1440, height: 1440 } }]),
      { assets: { pic: { ...ready, status: 'pending' } } },
    );
    expect(codes(bundle)).toContain('asset_not_ready');
    expect(bundle.diagnostics.find((x) => x.code === 'asset_not_ready')?.blockId).toBe(f);
    expect(Object.keys(bundle.assets)).toEqual([]);
  });

  it('places one file for the same image used in several places', async () => {
    const bundle = await run(
      doc([
        { type: 'figure', attrs: { id: nid('f'), asset: 'pic', width: 1440, height: 1440 } },
        { type: 'figure', attrs: { id: nid('f'), asset: 'pic', width: 720, height: 720 } },
      ]),
      { assets: { pic: ready } },
    );
    expect(Object.keys(bundle.assets)).toEqual([`assets/${PNG}.png`]);
    const uses = bundle.files['main.tex']!.split(`assets/${PNG}.png`).length - 1;
    expect(uses).toBe(2);
  });
});
