/**
 * EXP-120, third criterion: a failure of the lossless contract names the file, the part and the
 * first differing element. The corpus tests in roundtrip.test.ts and edits.test.ts use the same
 * checks (checkR0, checkR1); this file proves that their messages carry the three names.
 */
import { describe, expect, it } from 'vitest';
import {
  type R1Edit,
  checkR0,
  checkR1,
  entryData,
  exportDocx,
  importDocx,
  readZip,
  writeZip,
} from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const FILE = corpusFiles().find((f) => f.name === 'docx4j/sample-docx.docx')!;

/** The original package with one part's bytes replaced by `text` (the other parts are copied raw). */
function withPart(bytes: Uint8Array, part: string, text: string): Uint8Array {
  const zip = readZip(bytes);
  return writeZip(
    zip.entries.map((e) =>
      e.name === part
        ? { name: e.name, data: new TextEncoder().encode(text), like: e }
        : { name: e.name, copyOf: e, from: zip },
    ),
  );
}

describe('EXP-120: a failure names the file, the part and the first differing element', () => {
  it('reports R0 failures by part and by the first differing element of the part', async () => {
    const bytes = readFile(FILE);
    const imported = await importDocx(bytes);
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
    const zip = readZip(out.bytes);
    const doc = new TextDecoder().decode(entryData(zip, zip.byName.get('word/document.xml')!));
    expect(doc).toContain('<w:body>');
    const tampered = withPart(
      out.bytes,
      'word/document.xml',
      doc.replace('<w:body>', '<w:body><w:p><w:r><w:t>TAMPERED</w:t></w:r></w:p>'),
    );
    const r0 = checkR0(bytes, tampered);
    expect(r0.pass).toBe(false);
    expect(r0.diff.changed).toEqual(['word/document.xml']);
    expect(r0.differences).toHaveLength(1);
    // The inserted paragraph changes the body's children, so the first differing element is the body.
    expect(r0.differences[0]).toMatch(/^word\/document\.xml: \/w:document\[1\]\/w:body\[1\]/);
  });

  it('reports R1 violations by part when a part outside every edit changes', async () => {
    const bytes = readFile(FILE);
    const imported = await importDocx(bytes);
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
    const zip = readZip(out.bytes);
    const styles = zip.byName.get('word/styles.xml');
    expect(styles, 'the sample has a styles part').toBeDefined();
    const text = new TextDecoder().decode(entryData(zip, styles!));
    const tampered = withPart(
      out.bytes,
      'word/styles.xml',
      text.replace('<w:style ', '<w:style w:customStyle="1" '),
    );
    const edit: R1Edit = { name: 'no edit', edited: [], deleted: [], added: [], text: {} };
    const r1 = checkR1(bytes, tampered, imported.sourceMap, edit);
    expect(r1.pass).toBe(false);
    expect(
      r1.violations.some((v) =>
        v.startsWith('part word/styles.xml changed, but no edit reaches it'),
      ),
    ).toBe(true);
  });
});
