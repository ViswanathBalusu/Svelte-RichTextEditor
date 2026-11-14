/**
 * EXP-090, criterion 4 (lane export-docx-2, round 6): any string written to a DOCX part comes out
 * escaped for XML. Drawn by fast-check at a fixed seed. For every generated document the package
 * parses part by part, has no document type declaration and no external relationship, and the text
 * read back equals the text written, with the characters XML 1.0 cannot carry replaced by U+FFFD
 * (the rule of `xmlSafe` in `src/writer-xml.ts`). The strings are the paragraph texts and the name of
 * a paragraph style.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { newDocument, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { AssetStore, entryData, parseXml, readZip, type XmlElement } from '../src/index.ts';
import { NS } from '../src/ooxml.ts';
import { textContent } from '../src/xml.ts';
import { writeDocx } from '../src/writer.ts';
import { xmlSafe } from '../src/writer-xml.ts';

const SEED = 20261113;
const RUNS = 40;

/**
 * Well-formed Unicode strings (the model refuses lone surrogates, so they are not writer input),
 * with the characters that XML 1.0 forbids and the markup characters biased in.
 */
const anyString = fc.oneof(
  fc
    .array(
      fc.integer({ min: 0, max: 0x10ffff }).filter((c) => c < 0xd800 || c > 0xdfff),
      { maxLength: 12 },
    )
    .map((cps) => String.fromCodePoint(...cps)),
  fc
    .array(
      fc.constantFrom(
        '<',
        '>',
        '&',
        '&amp;',
        ']]>',
        '"',
        "'",
        '\u0000',
        '\u0008',
        '\u000B',
        '\u001F',
        '￾',
        '￿',
        ' ',
        '\u{1F600}',
      ),
      { maxLength: 12 },
    )
    .map((parts) => parts.join('')),
);

/** Tabs and line breaks are structure in the writer, not text, so the property keeps them out. */
const text = anyString.map((s) => s.replace(/[\t\n\r\v\f]/g, ' '));

function documentOf(paragraphs: string[], styleName: string): JsonEnvelope {
  const env = newDocument({ lang: 'en-GB' });
  const defs = env.doc.content!.find((n) => n.type === 'defs')!.content!;
  const at = defs.findIndex((n) => n.type === 'page_setup');
  defs.splice(at < 0 ? defs.length : at, 0, {
    type: 'style_def',
    attrs: { id: 'Plain', kind: 'paragraph', name: styleName },
  });
  const body = env.doc.content!.find((n) => n.type === 'body')!;
  body.content = paragraphs.map((s, k): JsonNode => ({
    type: 'paragraph',
    attrs: { id: `pz${String(k).padStart(14, '0')}`, style: 'Plain' },
    content: s ? [{ type: 'text', text: s }] : [],
  }));
  return env;
}

function partsOf(bytes: Uint8Array): Map<string, Uint8Array> {
  const zip = readZip(bytes);
  const out = new Map<string, Uint8Array>();
  for (const e of zip.entries) out.set(e.name, entryData(zip, e));
  return out;
}

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Every element with the given local name, in document order. */
function all(root: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const stack: XmlElement[] = [root];
  while (stack.length) {
    const e = stack.pop()!;
    if (e.local === local) out.push(e);
    for (let i = e.children.length - 1; i >= 0; i--) {
      const c = e.children[i]!;
      if (c.kind === 'element') stack.push(c);
    }
  }
  return out;
}

describe('EXP-090 criterion 4: strings are escaped, and the package has no DTD and no external relationship', () => {
  it('for any strings, the parts parse, carry no document type declaration, and read back as written', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(text, { minLength: 1, maxLength: 4 }),
        text,
        async (paras, name) => {
          const out = await writeDocx(documentOf(paras, name), new AssetStore());
          const parts = partsOf(out.bytes);

          for (const [part, data] of parts) {
            if (!/\.(xml|rels)$/.test(part)) continue;
            const xml = decode(data);
            expect(xml, `${part} has a document type declaration`).not.toMatch(/<!DOCTYPE/i);
            expect(() => parseXml(data), `${part} parses`).not.toThrow();
            if (part.endsWith('.rels'))
              expect(xml, `${part} has an external target`).not.toMatch(/TargetMode="External"/);
          }

          const doc = parseXml(parts.get('word/document.xml')!).root;
          const body = all(doc, 'body')[0]!;
          const written = all(body, 'p').map((p) => textContent(p));
          expect(written).toEqual(paras.map((s) => xmlSafe(s).text));

          const styles = parseXml(parts.get('word/styles.xml')!).root;
          const plain = all(styles, 'style').find((s) =>
            s.attrs.some((a) => a.local === 'styleId' && a.value === 'Plain'),
          )!;
          const nameEl = all(plain, 'name')[0]!;
          const val = nameEl.attrs.find((a) => a.ns === NS.w && a.local === 'val');
          expect(val?.value).toBe(xmlSafe(name).text);
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
  });
});
