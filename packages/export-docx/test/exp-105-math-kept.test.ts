/**
 * EXP-105 (blocked on the converter of EXP-054): what holds until a converter exists. Office math in
 * a Word file is kept as a preserved `equation` atom, written back as it was (R0 is checked on every
 * corpus file by `roundtrip.test.ts`), and the importer never stores a `latex` attribute, so no TeX
 * that the math gate has not seen can reach a document through an import.
 */
import { describe, expect, it } from 'vitest';
import { type JsonNode } from '@docedit/model';
import { importDocx } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

function walk(doc: JsonNode, visit: (n: JsonNode) => void): void {
  const stack: JsonNode[] = [doc];
  while (stack.length) {
    const n = stack.pop()!;
    visit(n);
    for (const c of n.content ?? []) stack.push(c);
  }
}

describe('Office math is kept and no latex is stored by the importer', () => {
  it('no imported node of any corpus file has a latex attribute', async () => {
    for (const file of corpusFiles()) {
      const { envelope } = await importDocx(readFile(file));
      walk(envelope.doc as JsonNode, (n) =>
        expect(n.attrs?.['latex'], `${file.name} ${n.type}`).toBeUndefined(),
      );
    }
  });

  it.each(['docx4j/equation-sample.docx', 'docx4j/tracked-changes-equations.docx'])(
    '%s: each equation is a preserved atom labelled equation',
    async (name) => {
      const file = corpusFiles().find((f) => f.name === name)!;
      const { envelope, report } = await importDocx(readFile(file));
      let atoms = 0;
      walk(envelope.doc as JsonNode, (n) => {
        if (n.type === 'preserved_inline' && n.attrs?.['label'] === 'equation') atoms++;
        expect(n.type, 'no equation node is made without a converter').not.toBe('equation');
      });
      expect(atoms).toBeGreaterThan(0);
      expect(report.find((i) => i.kind === 'equation')?.action).toBe('preserved');
    },
  );
});
