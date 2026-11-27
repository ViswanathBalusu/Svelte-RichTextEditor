/**
 * EXP-105: the importer reads Office math into `equation` and `equation_block` nodes through the
 * converter of this package, behind the math gate it is given. The gate here is a stand-in that
 * refuses what the test says (the real gate of `@docedit/export-latex` runs in
 * `services/export-worker/src/exp-105-docx-math-import.test.ts`, on the real Word files). The
 * packages are made by the direct writer, and one is changed to hold math the converter has no
 * reader for.
 */
import { describe, expect, it } from 'vitest';
import { newDocument, type JsonEnvelope, type JsonNode } from '@docedit/model';
import {
  AssetStore,
  checkR1,
  entryData,
  everyParagraph,
  exportDocx,
  importDocx,
  readZip,
  scriptedEdits,
  writeDocx,
} from '../src/index.ts';
import { writeZip } from '../src/zip.ts';

const gate = (latex: string): string | null =>
  latex.includes('forbidden') ? 'a test refusal' : null;

const t = (text: string): JsonNode => ({ type: 'text', text });
function sample(): JsonEnvelope {
  const env = newDocument();
  env.doc.content!.find((n) => n.type === 'body')!.content = [
    {
      type: 'paragraph',
      attrs: { id: 'pAAAAAAAAAAAAAA1' },
      content: [t('Ratio '), { type: 'equation', attrs: { latex: '\\frac{a}{b}' } }, t(' here.')],
    },
    { type: 'equation_block', attrs: { id: 'eAAAAAAAAAAAAAA1', latex: 'x^2 + y^2 = r^2' } },
    {
      type: 'paragraph',
      attrs: { id: 'pAAAAAAAAAAAAAA2' },
      content: [t('Sum '), { type: 'equation', attrs: { latex: '\\sum_{i=1}^{n} i' } }],
    },
  ] as JsonNode[];
  return env;
}

const partText = (bytes: Uint8Array, name: string): string => {
  const zip = readZip(bytes);
  return new TextDecoder().decode(entryData(zip, zip.byName.get(name)!));
};
function* walk(n: JsonNode): Generator<JsonNode> {
  yield n;
  for (const c of n.content ?? []) yield* walk(c);
}
const nodesOf = (env: JsonEnvelope, ...types: string[]): JsonNode[] =>
  [...walk(env.doc as unknown as JsonNode)].filter((n) => types.includes(n.type));

/** The package with a part's text changed. */
function withPart(bytes: Uint8Array, name: string, change: (text: string) => string): Uint8Array {
  const zip = readZip(bytes);
  return writeZip(
    zip.entries.map((e) =>
      e.name === name
        ? { name, data: new TextEncoder().encode(change(partText(bytes, name))), like: e }
        : { name: e.name, copyOf: e, from: zip },
    ),
  );
}

describe('EXP-105 criteria 1, 2 and 4: Office math becomes equations behind the gate', () => {
  it('reads inline math as equation and display math as equation_block, as LaTeX', async () => {
    const written = await writeDocx(sample(), new AssetStore());
    const r = await importDocx(written.bytes, { mathGate: gate });
    expect(nodesOf(r.envelope, 'equation').map((n) => n.attrs?.['latex'])).toEqual([
      '\\frac{a}{b}',
      '\\sum_{i=1}^n i',
    ]);
    expect(nodesOf(r.envelope, 'equation_block').map((n) => n.attrs?.['latex'])).toEqual([
      'x^2+y^2=r^2',
    ]);
    // No Office math is left as preserved content, and the imported document is valid with the gate.
    expect(nodesOf(r.envelope, 'preserved_inline', 'preserved_block')).toEqual([]);
    expect(r.envelope.requires).toContain('preserve');
  });

  it('writes an unedited import back byte for byte, and each edit only where it was made', async () => {
    const written = await writeDocx(sample(), new AssetStore());
    const r = await importDocx(written.bytes, { mathGate: gate });
    const same = await exportDocx(r.envelope, written.bytes, r.sourceMap, r.assets);
    expect(same.bytes).toEqual(written.bytes);

    const env = structuredClone(r.envelope);
    const [first] = nodesOf(env, 'equation');
    first!.attrs!['latex'] = '\\sqrt{z}';
    const [block] = nodesOf(env, 'equation_block');
    block!.attrs!['latex'] = 'E = m c^2';
    const out = await exportDocx(env, written.bytes, r.sourceMap, r.assets);
    const before = partText(written.bytes, 'word/document.xml');
    const after = partText(out.bytes, 'word/document.xml');
    expect(after).toContain('<m:rad>');
    expect(after).not.toContain('<m:f>');
    expect(after).toContain('<m:t>E</m:t>');
    // The third equation was not edited: its math element is the original's bytes.
    const sum = (t: string): string => t.slice(t.indexOf('<m:nary>'), t.indexOf('</m:nary>') + 9);
    expect(sum(after)).toBe(sum(before));
    expect(sum(after)).toContain('∑');
    // Imported again, the edits are the LaTeX.
    const again = await importDocx(out.bytes, { mathGate: gate });
    expect(nodesOf(again.envelope, 'equation').map((n) => n.attrs?.['latex'])).toEqual([
      '\\sqrt{z}',
      '\\sum_{i=1}^n i',
    ]);
    expect(nodesOf(again.envelope, 'equation_block').map((n) => n.attrs?.['latex'])).toEqual([
      'E=mc^2',
    ]);
  });

  it('passes R1 of ADR 0017 after each scripted edit and when every paragraph is regenerated', async () => {
    const written = await writeDocx(sample(), new AssetStore());
    const r = await importDocx(written.bytes, { mathGate: gate });
    for (const edit of scriptedEdits(r.envelope, r.sourceMap, r.assets)) {
      if ('skipped' in edit) continue;
      const out = await exportDocx(edit.envelope, written.bytes, r.sourceMap, r.assets);
      const r1 = checkR1(written.bytes, out.bytes, r.sourceMap, edit.edit);
      expect(r1.violations, edit.name).toEqual([]);
    }
    const every = everyParagraph(r.envelope, r.sourceMap);
    const out = await exportDocx(r.envelope, written.bytes, r.sourceMap, r.assets, {
      regenerate: new Set(every.edited),
    });
    expect(checkR1(written.bytes, out.bytes, r.sourceMap, every).violations).toEqual([]);
  });

  it('stores no LaTeX, and keeps the math as it was, when no gate is given', async () => {
    const written = await writeDocx(sample(), new AssetStore());
    const r = await importDocx(written.bytes);
    expect(nodesOf(r.envelope, 'equation', 'equation_block')).toEqual([]);
    expect(JSON.stringify(r.envelope)).not.toContain('"latex"');
    const out = await exportDocx(r.envelope, written.bytes, r.sourceMap, r.assets);
    expect(out.bytes).toEqual(written.bytes);
  });
});

describe('EXP-105 criterion 3: math that is refused or cannot be converted stays as Word has it', () => {
  it('keeps math whose converted LaTeX the gate refuses, and a warning names its block', async () => {
    const env = sample();
    nodesOf(env, 'equation_block')[0]!.attrs!['latex'] = '\\mathrm{forbidden} + 1';
    const written = await writeDocx(env, new AssetStore());
    const r = await importDocx(written.bytes, { mathGate: gate });
    expect(nodesOf(r.envelope, 'equation_block')).toEqual([]);
    const kept = nodesOf(r.envelope, 'preserved_block', 'preserved_inline').filter(
      (n) => n.attrs?.['label'] === 'equation',
    );
    expect(kept.length).toBe(1);
    const warning = r.warnings.find((w) => w.includes('a test refusal'));
    expect(warning).toBeDefined();
    const paragraph = nodesOf(r.envelope, 'paragraph', 'preserved_block').find(
      (n) =>
        n.type === 'preserved_block' ||
        (n.content ?? []).some((c) => c.attrs?.['label'] === 'equation'),
    )!;
    expect(warning).toContain(`block ${String(paragraph.attrs?.['id'])}`);
    const out = await exportDocx(r.envelope, written.bytes, r.sourceMap, r.assets);
    expect(out.bytes).toEqual(written.bytes);
  });

  it('keeps math the converter has no element for, and names it', async () => {
    const written = await writeDocx(sample(), new AssetStore());
    const bytes = withPart(written.bytes, 'word/document.xml', (xml) =>
      xml.replace('<m:f>', '<m:borderBox><m:e/></m:borderBox><m:f>'),
    );
    const r = await importDocx(bytes, { mathGate: gate });
    expect(nodesOf(r.envelope, 'equation').map((n) => n.attrs?.['latex'])).toEqual([
      '\\sum_{i=1}^n i',
    ]);
    const warning = r.warnings.find((w) => w.includes('cannot be converted'));
    expect(warning).toContain('m:borderBox');
    const out = await exportDocx(r.envelope, bytes, r.sourceMap, r.assets);
    expect(out.bytes).toEqual(bytes);
  });
});
