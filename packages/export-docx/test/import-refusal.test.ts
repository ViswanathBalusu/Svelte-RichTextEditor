/**
 * EXP-109, the refusal path of the import's own validate() check. Earlier rounds had no test that
 * the import refuses a result: the reviewer's crafted tables and nested runs were kept as preserved
 * content, so they passed validate() and never reached the refusal. The case here is one the
 * importer really produces and the model really refuses: a body of more than 16 MiB canonical size
 * (I7). The import must fail as a whole, name the limit, and return no document. The same content
 * imported with the check turned off yields a document that validate() refuses with the same code,
 * which shows the refusal comes from the check and not from the parser.
 *
 * Not covered here: the limits of 500 regions and of nesting depth 12. The importer does not yet
 * produce regions (EXP-104), and nesting that the importer models stays within 12 levels.
 */
import { randomFillSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validate } from '@docedit/model/validate';
import { ImportError, entryData, importDocx, readZip, writeZip } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const SAMPLE = corpusFiles().find((f) => f.name === 'docx4j/sample-docx.docx')!;

/** The sample package with its main part's text replaced by `transform(text)`; other parts are copied raw. */
function withDocument(bytes: Uint8Array, transform: (xml: string) => string): Uint8Array {
  const zip = readZip(bytes);
  const entry = zip.byName.get('word/document.xml')!;
  const xml = new TextDecoder().decode(entryData(zip, entry));
  const next = transform(xml);
  if (next === xml) throw new Error('the fixture did not change the document part');
  return writeZip(
    zip.entries.map((e) =>
      e.name === 'word/document.xml'
        ? { name: e.name, data: new TextEncoder().encode(next), like: e }
        : { name: e.name, copyOf: e, from: zip },
    ),
  );
}

/** A paragraph whose text is about 17.3 MB as UTF-8 (random base64, so the zip ratio limit is not hit). */
function oversizeParagraph(): string {
  const raw = new Uint8Array(13 * 1024 * 1024);
  randomFillSync(raw);
  const text = Buffer.from(raw).toString('base64');
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

describe('EXP-109: the import refuses a result that fails validate()', () => {
  it('fails as a whole, naming the canonical size limit, and returns no document', async () => {
    const bytes = withDocument(readFile(SAMPLE), (xml) =>
      xml.replace('<w:body>', `<w:body>${oversizeParagraph()}`),
    );
    const error = await importDocx(bytes).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ImportError);
    expect((error as Error).message).toMatch(/validate\(\)/);
    expect((error as Error).message).toMatch(/canonical_too_large/);
    expect((error as Error).message).toMatch(/16 MiB/);
  }, 120_000);

  it('produces the same violation when the check is off, so the refusal comes from validate()', async () => {
    const bytes = withDocument(readFile(SAMPLE), (xml) =>
      xml.replace('<w:body>', `<w:body>${oversizeParagraph()}`),
    );
    const imported = await importDocx(bytes, { validate: false });
    const result = validate(imported.envelope, { attachedAssets: imported.assets.ids() });
    expect(result.valid).toBe(false);
    expect(result.violations.map((v) => `${v.invariant} ${v.code}`)).toContain(
      'I7 canonical_too_large',
    );
  }, 120_000);

  it('keeps a table of 64 columns as preserved content, so the import never produces an over-limit table', async () => {
    const cols = '<w:gridCol w:w="500"/>'.repeat(64);
    const cells = '<w:tc><w:tcPr/><w:p/></w:tc>'.repeat(64);
    const table = `<w:tbl><w:tblPr/><w:tblGrid>${cols}</w:tblGrid><w:tr>${cells}</w:tr></w:tbl>`;
    const bytes = withDocument(readFile(SAMPLE), (xml) =>
      xml.replace('<w:body>', `<w:body>${table}`),
    );
    const imported = await importDocx(bytes);
    const result = validate(imported.envelope, { attachedAssets: imported.assets.ids() });
    expect(result.violations).toEqual([]);
    const grids: number[] = [];
    const stack: { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }[] = [
      imported.envelope.doc as never,
    ];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.type === 'table')
        grids.push(((n.attrs?.['grid'] as unknown[] | undefined) ?? []).length);
      for (const c of (n.content ?? []) as typeof stack) stack.push(c);
    }
    expect(grids.every((g) => g <= 63)).toBe(true);
  });
});
