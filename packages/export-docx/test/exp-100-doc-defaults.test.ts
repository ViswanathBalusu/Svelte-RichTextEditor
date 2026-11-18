/**
 * EXP-100, criterion 5 (the defaults as the default paragraph style): the paragraph and run
 * defaults of `w:docDefaults` in styles.xml are merged into the default paragraph style that
 * `settings.defaultParagraphStyle` names, below the style's own values (ADR 0372). The test reads
 * styles.xml of every corpus file itself and compares the imported style with the file.
 * Run in Node.js with vitest.
 */
import { describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import { entryData, importDocx, readZip } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

function find(doc: JsonNode, pick: (n: JsonNode) => boolean): JsonNode | undefined {
  const stack: JsonNode[] = [doc];
  while (stack.length) {
    const n = stack.pop()!;
    if (pick(n)) return n;
    for (const c of n.content ?? []) stack.push(c);
  }
  return undefined;
}

interface Expected {
  spaceAfter?: number;
  fontSize?: number;
  fontFamily?: string;
}

/** What the file says for a property of a `w:style` or `w:docDefaults` body. */
function read(body: string): Expected {
  const out: Expected = {};
  const after = /<w:spacing\b[^>]*\bw:after="(\d+)"/.exec(body);
  if (after) out.spaceAfter = Number(after[1]);
  const sz = /<w:sz\b[^>]*\bw:val="(\d+)"/.exec(body);
  if (sz) out.fontSize = Number(sz[1]) * 10;
  const font = /<w:rFonts\b[^>]*\bw:ascii="([^"]+)"/.exec(body);
  if (font) out.fontFamily = font[1]!;
  return out;
}

/** The default paragraph style of styles.xml, with its body and whether it has a `w:basedOn`. */
function defaultStyle(xml: string): { body: string; basedOn: boolean } | undefined {
  for (const m of xml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const head = m[1]!;
    if (/w:type="paragraph"/.test(head) && /w:default="(1|true|on)"/.test(head))
      return { body: m[2]!, basedOn: /<w:basedOn\b/.test(m[2]!) };
  }
  return undefined;
}

describe('EXP-100 criterion 5: w:docDefaults become the default paragraph style', () => {
  it('gives the default style its own value, else the document default, on every corpus file', async () => {
    const fromDefaults: Record<string, number> = { spaceAfter: 0, fontSize: 0, fontFamily: 0 };
    let checked = 0;
    for (const file of corpusFiles()) {
      const bytes = readFile(file);
      const zip = readZip(bytes);
      const entry = zip.entries.find((e) => e.name === 'word/styles.xml');
      if (!entry) continue;
      const xml = new TextDecoder().decode(entryData(zip, entry));
      const def = defaultStyle(xml);
      if (!def || def.basedOn) continue;
      const dd = /<w:docDefaults>([\s\S]*?)<\/w:docDefaults>/.exec(xml);
      const defaults = dd ? read(dd[1]!) : {};
      const own = read(def.body);
      const imported = await importDocx(bytes);
      const doc = imported.envelope.doc as JsonNode;
      const settings = find(doc, (n) => n.type === 'settings');
      const styleId = settings?.attrs?.['defaultParagraphStyle'];
      const style = find(doc, (n) => n.type === 'style_def' && n.attrs?.['id'] === styleId);
      expect(style, file.name).toBeDefined();
      for (const key of ['spaceAfter', 'fontSize', 'fontFamily'] as const) {
        const want = own[key] ?? defaults[key];
        expect(style!.attrs?.[key], `${file.name} ${key}`).toBe(want);
        if (own[key] === undefined && defaults[key] !== undefined) fromDefaults[key]!++;
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
    // The corpus holds files whose value comes from the document defaults alone.
    expect(fromDefaults['spaceAfter']).toBeGreaterThan(0);
    expect(fromDefaults['fontFamily']).toBeGreaterThan(0);
  });

  it('keeps a value the default style sets itself over the document default', async () => {
    // docx4j/tables.docx: w:docDefaults has sz 22 and the default style sets sz 24.
    const file = corpusFiles().find((f) => f.name === 'docx4j/tables.docx');
    if (!file) throw new Error('missing corpus file docx4j/tables.docx');
    const imported = await importDocx(readFile(file));
    const normal = find(
      imported.envelope.doc as JsonNode,
      (n) => n.type === 'style_def' && n.attrs?.['id'] === 'Normal',
    );
    expect(normal?.attrs?.['fontSize']).toBe(240);
    expect(normal?.attrs?.['spaceAfter']).toBe(200);
    expect(normal?.attrs?.['lineSpacing']).toBe(1150);
  });
});
