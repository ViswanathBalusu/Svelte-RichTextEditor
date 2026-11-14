/**
 * EXP-107, criterion 1 for floating objects: an anchored drawing (`wp:anchor`) gets its own line in
 * the import report, `floating object`, beside its content kind. The count is checked against an
 * independent count of `wp:anchor` elements in the parts of the document and its stories over the
 * S11 corpus (corpus/SOURCES.md), and an inline drawing is not counted. Criterion 1 stays open for
 * the multi-paragraph footnote kind, which the importer does not read yet (EXP-102).
 */
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { importDocx, type ImportReportItem } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

/** Anchors counted in the package's XML, without the importer. */
function anchorsIn(bytes: Uint8Array): number {
  let n = 0;
  for (const [name, data] of Object.entries(unzipSync(bytes))) {
    if (!PART.test(name)) continue;
    n += strFromU8(data).match(/<wp:anchor[\s>]/g)?.length ?? 0;
  }
  return n;
}

const countOf = (report: ImportReportItem[], kind: string): number | undefined =>
  report.find((i) => i.kind === kind)?.count;

describe('floating objects get a line of their own in the report', () => {
  it.each([
    ['docx4j/DrawingML_GraphicData_wps.docx', 1],
    ['docx4j/cr043-tracked.docx', 1],
    ['docx4j/textbox_alternates_contrived.docx', 1],
    ['poi/60316.docx', 4],
    ['poi/shapes-with-text.docx', 7],
  ])('%s reports %i floating objects', async (name, count) => {
    const file = corpusFiles().find((f) => f.name === name);
    if (!file) throw new Error(`missing corpus file ${name}`);
    const { report } = await importDocx(readFile(file));
    expect(countOf(report, 'floating object')).toBe(count);
  });

  it('does not count an inline text box as floating', async () => {
    const file = corpusFiles().find((f) => f.name === 'docx4j/textbox.docx');
    if (!file) throw new Error('missing corpus file docx4j/textbox.docx');
    const { report } = await importDocx(readFile(file));
    expect(countOf(report, 'text box')).toBe(1);
    expect(countOf(report, 'floating object')).toBeUndefined();
  });

  it('agrees with the anchors in the package XML over the whole corpus', async () => {
    for (const file of corpusFiles()) {
      const bytes = readFile(file);
      const { report } = await importDocx(bytes);
      const expected = anchorsIn(bytes);
      expect(countOf(report, 'floating object') ?? 0, file.name).toBe(expected);
    }
  });

  it('keeps the floating line preserved, with the same message as its content kind', async () => {
    const file = corpusFiles().find((f) => f.name === 'poi/60316.docx');
    if (!file) throw new Error('missing corpus file poi/60316.docx');
    const { report } = await importDocx(readFile(file));
    const item = report.find((i) => i.kind === 'floating object');
    expect(item?.action).toBe('preserved');
    expect(item?.message).toBe('preserved, not editable');
    expect(item?.blocks.length).toBeGreaterThan(0);
  });
});
