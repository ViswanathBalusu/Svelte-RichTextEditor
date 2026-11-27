// EXP-096 criterion 4 with the real math gate of EXP-049: an equation that fails it is written to
// DOCX as the visible placeholder, the warnings name its block, and the rest is written. The
// writer takes the gate as a function (it does not depend on export-latex); the export worker is
// the package that depends on both, so the gate is wired here. The writer is imported by its
// source path, as other tests of the services do. The worker has no `docx` target yet (EXP-090).
import { describe, expect, it } from 'vitest';
import { mathGateReason } from '@docedit/export-latex';
import { newDocument, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { AssetStore, entryData, readZip } from '../../../packages/export-docx/src/index.ts';
import { MATH_PLACEHOLDER, writeDocx } from '../../../packages/export-docx/src/writer.ts';

type Attrs = NonNullable<JsonNode['attrs']>;
const t = (text: string): JsonNode => ({ type: 'text', text });
const p = (id: string, content: JsonNode[]): JsonNode => ({
  type: 'paragraph',
  attrs: { id } as Attrs,
  content,
});
const bodyOf = (env: JsonEnvelope): JsonNode => env.doc.content!.find((n) => n.type === 'body')!;
const documentXml = (bytes: Uint8Array): string => {
  const zip = readZip(bytes);
  return new TextDecoder().decode(
    entryData(
      zip,
      zip.entries.find((e) => e.name === 'word/document.xml')!,
    ),
  );
};

describe('DOCX export with the real math gate (EXP-096)', () => {
  it('replaces equations the gate refuses, names their blocks, and writes the rest', async () => {
    const bad = String.raw`\def\x{1} x`;
    expect(mathGateReason(bad, true)).not.toBeNull();
    expect(mathGateReason(bad, false)).not.toBeNull();
    expect(mathGateReason('a^2+b^2=c^2', true)).toBeNull();
    const env = newDocument();
    bodyOf(env).content = [
      p('pAAAAAAAAAAAAAA1', [t('Before')]),
      { type: 'equation_block', attrs: { id: 'eBadAAAAAAAAAAA1', latex: bad } },
      { type: 'equation_block', attrs: { id: 'eOkAAAAAAAAAAAA1', latex: 'a^2+b^2=c^2' } },
      p('pInlineAAAAAAA1', [t('Inline '), { type: 'equation', attrs: { latex: bad } }, t(' end')]),
    ];
    const out = await writeDocx(env, new AssetStore(), { mathGate: mathGateReason });
    const xml = documentXml(out.bytes);
    expect(xml).not.toContain(String.raw`\def`);
    expect(xml.split(MATH_PLACEHOLDER).length - 1).toBe(2);
    for (const text of ['Before', 'Inline ', ' end']) expect(xml).toContain(text);
    // The accepted equation is Office math, from the converter of EXP-096, and not its source text.
    expect(xml).toContain('<m:oMathPara');
    expect(xml).not.toContain('a^2+b^2=c^2');
    expect(out.warnings.some((w) => w.includes('block eBadAAAAAAAAAAA1'))).toBe(true);
    expect(out.warnings.some((w) => w.includes('block pInlineAAAAAAA1'))).toBe(true);
  });
});
