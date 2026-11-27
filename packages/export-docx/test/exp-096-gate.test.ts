/**
 * EXP-096 criterion 4: an equation that fails the math gate is replaced by a visible placeholder,
 * the warnings name its block, and the rest of the document is written. The gate is injected, as
 * the authority's room receives it (`RoomInit.mathGate`); here a stub that refuses `\def`.
 */
import { describe, expect, it } from 'vitest';
import { newDocument, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { AssetStore, entryData, readZip } from '../src/index.ts';
import { MATH_PLACEHOLDER, writeDocx } from '../src/writer.ts';
import { nid } from './writer-docs.ts';

type Attrs = NonNullable<JsonNode['attrs']>;
const t = (text: string): JsonNode => ({ type: 'text', text });
const p = (id: string, content: JsonNode[]): JsonNode => ({
  type: 'paragraph',
  attrs: { id } as Attrs,
  content,
});
const bodyOf = (env: JsonEnvelope): JsonNode => env.doc.content!.find((n) => n.type === 'body')!;
const gate = (latex: string): string | null =>
  latex.includes('\\def') ? 'the control sequence \\def is forbidden' : null;

const documentXml = (bytes: Uint8Array): string => {
  const zip = readZip(bytes);
  const entry = zip.entries.find((e) => e.name === 'word/document.xml')!;
  return new TextDecoder().decode(entryData(zip, entry));
};

describe('the DOCX writer and the math gate (EXP-096)', () => {
  it('replaces refused equations by a placeholder, names their blocks, and writes the rest', async () => {
    const env = newDocument();
    const para = nid('p');
    const display = nid('e');
    bodyOf(env).content = [
      p(nid('p'), [t('Before the display')]),
      { type: 'equation_block', attrs: { id: display, latex: '\\def\\x{1} x' } },
      { type: 'equation_block', attrs: { id: nid('e'), latex: 'a^2+b^2=c^2' } },
      p(para, [
        t('Inline '),
        { type: 'equation', attrs: { latex: '\\def\\y{2}' } },
        t(' and after'),
      ]),
      p(nid('p'), [t('Last paragraph')]),
    ];
    const out = await writeDocx(env, new AssetStore(), { mathGate: gate });
    const xml = documentXml(out.bytes);
    // The refused equations leave no trace of their source, and each is a visible placeholder.
    expect(xml).not.toContain('\\def');
    expect(xml.split(MATH_PLACEHOLDER).length - 1).toBe(2);
    // The rest of the document is written, and the accepted equation is Office math (EXP-096).
    for (const text of ['Before the display', 'Inline ', ' and after', 'Last paragraph'])
      expect(xml).toContain(text);
    expect(xml).toContain('<m:oMath');
    // The diagnostics carry the block identifiers: the display's own, and the inline one's paragraph.
    expect(out.warnings.some((w) => w.includes(`block ${display}`))).toBe(true);
    expect(out.warnings.some((w) => w.includes(`block ${para}`))).toBe(true);
  });

  it('checks nothing when no gate is given, and passes an accepted equation through (the control)', async () => {
    const env = newDocument();
    bodyOf(env).content = [
      { type: 'equation_block', attrs: { id: nid('e'), latex: '\\def\\x{1}' } },
    ];
    const unchecked = await writeDocx(env, new AssetStore());
    expect(documentXml(unchecked.bytes)).toContain('\\def');
    expect(unchecked.warnings.some((w) => w.includes('math gate'))).toBe(false);
    const accepting = await writeDocx(env, new AssetStore(), { mathGate: () => null });
    expect(documentXml(accepting.bytes)).toContain('\\def');
  });
});
