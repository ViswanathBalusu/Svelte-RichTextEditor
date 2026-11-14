/**
 * EXP-117, criterion 3 (lane export-docx-2, round 2): a preserved drawing with no rendering in the
 * file gets a `fallbackText` that names its kind ("text box", "chart", ...), not the text of its
 * drawing XML. A drawing with a fallback picture keeps the picture as its `fallbackAsset`.
 */
import { describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import { importDocx } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const DRAWN_LABELS = new Set(['text box', 'shape', 'chart', 'group', 'canvas', 'SmartArt']);

/** Every preserved atom of a document, with its attributes. */
function atomsOf(doc: JsonNode): JsonNode[] {
  const out: JsonNode[] = [];
  const stack: JsonNode[] = [doc];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'preserved_inline' || n.type === 'preserved_block') out.push(n);
    for (const c of n.content ?? []) stack.push(c);
  }
  return out;
}

describe('criterion 3: the fallback of a drawing without a rendering names its kind', () => {
  it('every drawn atom without a fallback picture has its kind as fallbackText', async () => {
    let checked = 0;
    for (const file of corpusFiles()) {
      const { envelope } = await importDocx(readFile(file));
      for (const atom of atomsOf(envelope.doc as JsonNode)) {
        const label = atom.attrs?.['label'];
        if (typeof label !== 'string' || !DRAWN_LABELS.has(label)) continue;
        if (atom.attrs?.['fallbackAsset'] !== undefined) continue;
        checked++;
        expect(atom.attrs?.['fallbackText'], `${file.name} ${label}`).toBe(label);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('a text box of docx4j/textbox.docx is named "text box", not its drawing XML', async () => {
    const file = corpusFiles().find((f) => f.name === 'docx4j/textbox.docx')!;
    const atoms = atomsOf((await importDocx(readFile(file))).envelope.doc as JsonNode);
    const boxes = atoms.filter((a) => a.attrs?.['label'] === 'text box');
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      if (box.attrs?.['fallbackAsset'] !== undefined) continue;
      expect(box.attrs?.['fallbackText']).toBe('text box');
    }
  });
});
