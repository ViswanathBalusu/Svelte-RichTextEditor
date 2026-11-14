/**
 * EXP-117, criteria 1 and 5 (lane EXP-105-117), on every corpus file:
 * - criterion 5: every preserved kind of the import report is worded "preserved, not editable"
 *   and has a count; each kind of a preserved atom has its own line, with the count of its atoms.
 * - criterion 1, in part: the preserved atoms of the body keep their original position. In
 *   document order, each atom's fragment XML is found in the body part (`word/document.xml`) at an
 *   offset after the previous atom's. Which kinds are covered is not checked here (see EXP-117).
 */
import { describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import { entryData, importDocx, readFragment, readZip } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const WORDING = 'preserved, not editable';
const BODY_PART = 'word/document.xml';

/** Every preserved atom of a document, in document order (depth first, children in order). */
function atomsInOrder(doc: JsonNode): JsonNode[] {
  const out: JsonNode[] = [];
  const visit = (n: JsonNode): void => {
    if (n.type === 'preserved_inline' || n.type === 'preserved_block') {
      out.push(n);
      return;
    }
    for (const c of n.content ?? []) visit(c);
  };
  visit(doc);
  return out;
}

describe('EXP-117 criterion 5: every preserved kind is reported as preserved, not editable, with a count', () => {
  it('every preserved item has the wording, a count, and every atom kind has its own line with its count', async () => {
    let kinds = 0;
    let items = 0;
    for (const file of corpusFiles()) {
      const result = await importDocx(readFile(file));
      const byLabel = new Map<string, number>();
      for (const atom of atomsInOrder(result.envelope.doc as JsonNode)) {
        const label = atom.attrs?.['label'];
        if (typeof label !== 'string') continue;
        byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
      }
      const preserved = result.report.filter((i) => i.action === 'preserved');
      for (const item of preserved) {
        items++;
        expect(
          item.message.startsWith(WORDING),
          `${file.name} ${item.kind}: "${item.message}"`,
        ).toBe(true);
        expect(item.count, `${file.name} ${item.kind}`).toBeGreaterThan(0);
      }
      for (const [label, n] of byLabel) {
        kinds++;
        const item = preserved.find((i) => i.kind === label);
        expect(item, `${file.name} reports ${label}`).toBeDefined();
        expect(item!.count, `${file.name} count of ${label}`).toBe(n);
      }
    }
    expect(kinds).toBeGreaterThan(0);
    expect(items).toBeGreaterThan(0);
  });
});

describe('EXP-117 criterion 1 (in part): preserved atoms keep their position in the body', () => {
  it('in document order, each body atom’s fragment XML occurs in the source part after the previous atom', async () => {
    let checked = 0;
    for (const file of corpusFiles()) {
      const bytes = readFile(file);
      const source = readZip(bytes);
      const result = await importDocx(bytes);
      let cursor = 0;
      for (const atom of atomsInOrder(result.envelope.doc as JsonNode)) {
        const id = atom.attrs?.['fragment'];
        if (typeof id !== 'string') continue;
        const f = readFragment(result.assets.get(id)!.bytes);
        if (f.meta.part !== BODY_PART) continue;
        checked++;
        const sourcePart = new TextDecoder().decode(
          entryData(source, source.byName.get(BODY_PART)!),
        );
        const at = sourcePart.indexOf(f.xml, cursor);
        expect(
          at,
          `${file.name} ${atom.attrs?.['label']} occurs after the previous atom`,
        ).toBeGreaterThanOrEqual(0);
        cursor = at + f.xml.length;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
