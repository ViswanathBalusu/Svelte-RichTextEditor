/**
 * EXP-107, criteria 1 to 3 over the S11 corpus: the import report names every kind of content it
 * kept as preserved, dropped or approximated, with a count and the blocks that hold it, and a file
 * with none of that content gets an empty report. The kinds below are the ones the corpus holds
 * (corpus/SOURCES.md). Floating drawings have no kind of their own: an anchored drawing is reported
 * under its content kind (picture, shape or text box), so criterion 1 for floating objects is open.
 */
import { describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import { importDocx, type ImportReportItem } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const ACTIONS: ReadonlySet<ImportReportItem['action']> = new Set([
  'preserved',
  'dropped',
  'approximated',
]);

const corpus = new Map(corpusFiles().map((f) => [f.name, f]));

function idsOf(doc: JsonNode): Set<string> {
  const ids = new Set<string>();
  const stack: JsonNode[] = [doc];
  while (stack.length) {
    const n = stack.pop()!;
    const id = n.attrs?.['id'];
    if (typeof id === 'string') ids.add(id);
    for (const c of n.content ?? []) stack.push(c);
  }
  return ids;
}

async function reportOf(name: string) {
  const file = corpus.get(name);
  if (!file) throw new Error(`missing corpus file ${name}`);
  const imported = await importDocx(readFile(file));
  return { imported, report: imported.report };
}

const countOf = (report: ImportReportItem[], kind: string): number | undefined =>
  report.find((i) => i.kind === kind)?.count;

describe('criterion 1: each kind of content in the file gets a warning with a count', () => {
  it.each([
    ['docx4j/textbox.docx', 'text box', 1],
    ['poi/shapes-with-text.docx', 'text box', 4],
    ['poi/shapes-with-text.docx', 'shape', 2],
    ['poi/shapes-with-text.docx', 'group', 1],
    ['poi/60316.docx', 'shape', 2],
    ['poi/deep-table-cell.docx', 'nested table', 1],
    ['poi/FieldCodes.docx', 'field', 6],
    ['poi/footnotes.docx', 'footnote', 1],
    ['poi/endnotes.docx', 'endnote', 1],
    ['python-docx/shp-inline-shape-access.docx', 'chart', 1],
    ['python-docx/shp-inline-shape-access.docx', 'SmartArt', 1],
  ])('%s reports %s with count %i', async (name, kind, count) => {
    const { report } = await reportOf(name);
    expect(countOf(report, kind), `count of ${kind}`).toBe(count);
  });
});

describe('criterion 2: each warning names the kind, the action and the blocks it affects', () => {
  it.each([...corpus.keys()])('%s', async (name) => {
    const { imported, report } = await reportOf(name);
    const ids = idsOf(imported.envelope.doc as JsonNode);
    const seen = new Set<string>();
    for (const item of report) {
      expect(ACTIONS.has(item.action), `action of ${item.kind}`).toBe(true);
      expect(item.kind.length, 'kind is named').toBeGreaterThan(0);
      expect(item.message.length, 'message').toBeGreaterThan(0);
      expect(item.count).toBeGreaterThanOrEqual(1);
      // Blocks are unique, at most 100, and each one is a node of the imported document.
      expect(new Set(item.blocks).size).toBe(item.blocks.length);
      expect(item.blocks.length).toBeLessThanOrEqual(Math.min(100, item.count));
      for (const b of item.blocks) expect(ids.has(b), `block ${b} of ${item.kind}`).toBe(true);
      // One line per kind and action.
      const key = `${item.action}\u0000${item.kind}`;
      expect(seen.has(key), `duplicate line ${item.kind}`).toBe(false);
      seen.add(key);
    }
  });

  it('names the block that holds a text box', async () => {
    const { imported, report } = await reportOf('docx4j/textbox.docx');
    const item = report.find((i) => i.kind === 'text box')!;
    expect(item.action).toBe('preserved');
    expect(item.message).toBe('preserved, not editable');
    expect(item.blocks).toHaveLength(1);
    const ids = idsOf(imported.envelope.doc as JsonNode);
    expect(ids.has(item.blocks[0]!)).toBe(true);
  });
});

describe('criterion 3: a file with none of this content has an empty report', () => {
  it.each(['poi/Styles.docx', 'python-docx/tbl-cell-props.docx'])('%s', async (name) => {
    const { report } = await reportOf(name);
    expect(report).toEqual([]);
  });
});
