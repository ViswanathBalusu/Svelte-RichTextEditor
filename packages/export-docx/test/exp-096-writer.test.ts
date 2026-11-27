/**
 * EXP-096: the DOCX writer writes an equation that passes the gate as Office math, converted by the
 * converter of this package (EXP-054, owner decision 234), and an equation the converter does not
 * take as its LaTeX source with a warning that names the block. The gate comes first and is not
 * replaced (`exp-096-gate.test.ts`; the real gate runs in `services/export-worker`).
 */
import { describe, expect, it } from 'vitest';
import { newDocument, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { AssetStore, entryData, parseXml, readZip, type XmlElement } from '../src/index.ts';
import { MATH_PLACEHOLDER, writeDocx } from '../src/writer.ts';

const t = (text: string): JsonNode => ({ type: 'text', text });
const docWith = (...blocks: JsonNode[]): JsonEnvelope => {
  const env = newDocument();
  env.doc.content!.find((n) => n.type === 'body')!.content = blocks;
  return env;
};
const para = (id: string, ...content: JsonNode[]): JsonNode => ({
  type: 'paragraph',
  attrs: { id },
  content,
});
const documentXml = (bytes: Uint8Array): string => {
  const zip = readZip(bytes);
  return new TextDecoder().decode(entryData(zip, zip.byName.get('word/document.xml')!));
};
const all = (root: XmlElement, local: string): XmlElement[] => {
  const out: XmlElement[] = [];
  const stack = [root];
  while (stack.length) {
    const e = stack.pop()!;
    if (e.local === local) out.push(e);
    for (const c of e.children) if (c.kind === 'element') stack.push(c);
  }
  return out;
};

describe('EXP-096 criterion 1: equations become Office math', () => {
  it('writes an inline equation as m:oMath inside its paragraph, with no LaTeX text', async () => {
    const env = docWith(
      para(
        'pAAAAAAAAAAAAAA1',
        t('Energy '),
        { type: 'equation', attrs: { latex: 'E = \\frac{m c^2}{2}' } },
        t(' is shown.'),
      ),
    );
    const out = await writeDocx(env, new AssetStore());
    const xml = documentXml(out.bytes);
    const root = parseXml(new TextEncoder().encode(xml)).root;
    const maths = all(root, 'oMath');
    expect(maths.length).toBe(1);
    expect(maths[0]!.ns).toBe('http://schemas.openxmlformats.org/officeDocument/2006/math');
    expect(all(maths[0]!, 'f').length).toBe(1);
    expect(xml).not.toContain('\\frac');
    expect(xml).toContain('Energy ');
    expect(xml).toContain(' is shown.');
    expect(out.warnings.filter((w) => w.includes('equation'))).toEqual([]);
  });

  it('writes a display equation as a math paragraph, and a numbered one with its number', async () => {
    const env = docWith(
      { type: 'equation_block', attrs: { id: 'eAAAAAAAAAAAAAA1', latex: 'a^2 + b^2 = c^2' } },
      {
        type: 'equation_block',
        attrs: { id: 'eAAAAAAAAAAAAAA2', latex: '\\sum_{i=1}^{n} i', numbered: true },
      },
    );
    const out = await writeDocx(env, new AssetStore());
    const xml = documentXml(out.bytes);
    const root = parseXml(new TextEncoder().encode(xml)).root;
    expect(all(root, 'oMathPara').length).toBe(1);
    expect(all(root, 'oMath').length).toBe(2);
    expect(all(root, 'nary').length).toBe(1);
    expect(xml).not.toContain('a^2 + b^2');
    expect(xml).toMatch(/\(1\)/);
  });

  it('keeps the placeholder for an equation the gate refuses, and the source text for one only the converter refuses', async () => {
    const env = docWith(
      { type: 'equation_block', attrs: { id: 'eBadAAAAAAAAAAA1', latex: '\\def\\x{1}' } },
      {
        type: 'equation_block',
        attrs: { id: 'eOddAAAAAAAAAAA1', latex: '\\begin{aligned} a &= b \\end{aligned}' },
      },
      para('pAAAAAAAAAAAAAA2', { type: 'equation', attrs: { latex: '\\mathcal{L}' } }),
    );
    const out = await writeDocx(env, new AssetStore(), {
      mathGate: (latex) =>
        latex.includes('\\def') ? 'the control sequence \\def is forbidden' : null,
    });
    const xml = documentXml(out.bytes);
    expect(xml).toContain(MATH_PLACEHOLDER);
    expect(xml).not.toContain('\\def');
    // Not converted: written as the source, and said so, naming the block and the reason.
    expect(xml).toContain('\\begin{aligned}');
    expect(xml).toContain('\\mathcal{L}');
    const named = out.warnings.filter((w) => w.includes('cannot be converted to Office math'));
    expect(named.some((w) => w.includes('eOddAAAAAAAAAAA1'))).toBe(true);
    expect(named.length).toBe(2);
    // The refused equations are not Office math.
    expect(all(parseXml(new TextEncoder().encode(xml)).root, 'oMath').length).toBe(0);
  });

  it('writes a deleted equation (a tracked change) as its source text', async () => {
    const env = docWith(
      para('pAAAAAAAAAAAAAA3', t('x'), {
        type: 'equation',
        attrs: { latex: 'y^2' },
        marks: [{ type: 'del', attrs: { id: 'sAAAAAAAAAAAAAA1', user: 'u' } }],
      } as JsonNode),
    );
    const out = await writeDocx(env, new AssetStore(), { suggestions: 'markup' });
    const xml = documentXml(out.bytes);
    expect(xml).toContain('<w:delText>y^2</w:delText>');
  });
});
