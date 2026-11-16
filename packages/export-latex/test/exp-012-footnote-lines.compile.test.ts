/**
 * EXP-012 criterion 2 (lane w2; Podman, export worker sandbox): giving a footnote's text lines of
 * its own in main.tex does not change what is typeset.
 *
 * The converter writes a footnote's text on its own lines, between a `%` line end before it and a
 * `%` line end after it, so that map.json can give those lines to the footnote. This test compiles
 * the bundle as written, and again with the footnote lines joined back onto the host's line (the
 * form main.tex had before), and compares the class's layout report of the two compiles. The
 * report holds the pages, the line boxes and their positions; it does not hold line numbers of
 * main.tex, so equal reports mean equal typeset output.
 *
 * Skipped when the sandbox cannot run here.
 */
import { describe, expect, it } from 'vitest';
import { convert, type Bundle } from '../src/index.ts';
import { classFiles, compileBundle, firstError, imageFonts, sandboxReady } from './harness.ts';
import { doc, nid, para } from './docs.ts';

const ready = (await sandboxReady()).ok;

const note = (wording: string): Record<string, unknown> => ({
  type: 'footnote',
  attrs: { id: nid('n') },
  content: [
    {
      type: 'paragraph',
      attrs: { id: nid('p') },
      content: [
        { type: 'text', text: `${wording} ` },
        { type: 'text', text: 'in bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' and plain again.' },
      ],
    },
  ],
});

function envelope() {
  return doc([
    para('A paragraph of the body with a first note', {}, [
      note('First note'),
      { type: 'text', text: ' then more text and a second note' },
      note('Second note'),
      { type: 'text', text: ' and a tail that follows the notes.' },
    ]),
    {
      type: 'table',
      attrs: { id: nid('t'), grid: [2880, 2880] },
      content: [
        {
          type: 'table_row',
          attrs: { id: nid('r') },
          content: [
            {
              type: 'table_cell',
              attrs: { id: nid('c') },
              content: [para('A cell with a note', {}, [note('Cell note')])],
            },
            { type: 'table_cell', attrs: { id: nid('c') }, content: [para('A plain cell.')] },
          ],
        },
      ],
    },
    para('A last paragraph.'),
  ]);
}

/** main.tex with every footnote's lines joined back onto the line before and the line after. */
function joined(bundle: Bundle): { text: string; ranges: number } {
  const lines = bundle.files['main.tex']!.split('\n');
  const out: string[] = [];
  let ranges = 0;
  const isNote = (k: number | null): boolean =>
    k !== null &&
    (bundle.map.kinds[k] === 'footnoteParagraph' || bundle.map.kinds[k] === 'footnote');
  const owner = (n: number): number | null =>
    bundle.map.lines.find((r) => n >= r.from && n <= r.to)?.block ?? null;
  lines.forEach((l, i) => {
    const mine = isNote(owner(i + 1));
    const prev = i > 0 && isNote(owner(i));
    if (mine && !prev) {
      // First line of a footnote: the host line before it ends in `%`.
      ranges++;
      const before = out.pop()!;
      expect(before.endsWith('{%')).toBe(true);
      out.push(before.slice(0, -1) + l);
    } else if (!mine && prev) {
      // The host line after a footnote: the footnote's last line ends in `%`.
      const before = out.pop()!;
      expect(before.endsWith('%')).toBe(true);
      out.push(before.slice(0, -1) + l);
    } else out.push(l);
  });
  return { text: out.join('\n'), ranges };
}

describe.skipIf(!ready)('EXP-012 footnote lines of their own typeset the same (compile)', () => {
  it('gives the same layout report with the footnote text on its own lines and joined to the host', async () => {
    const bundle = await convert(envelope(), {
      fonts: await imageFonts(),
      classFiles: classFiles(),
    });
    const old = joined(bundle);
    expect(old.ranges).toBe(3);
    expect(old.text).not.toBe(bundle.files['main.tex']);

    const a = await compileBundle(bundle);
    expect(a.compile.ok, firstError(a.compile.log)).toBe(true);
    const b = await compileBundle({ ...bundle, files: { ...bundle.files, 'main.tex': old.text } });
    expect(b.compile.ok, firstError(b.compile.log)).toBe(true);

    expect(a.compile.layoutRaw).not.toBeNull();
    expect(a.compile.layoutRaw).toBe(b.compile.layoutRaw);
    expect(a.compile.passes.length).toBe(b.compile.passes.length);
    expect(a.compile.pdf?.length).toBe(b.compile.pdf?.length);
  }, 600_000);
});
