/**
 * EXP-033 criterion 8 (Node.js, sandbox): the compiled PDF holds no live PDF form fields. The
 * converter's bundle is compiled in the export worker's sandbox (Podman) through `test/harness.ts`.
 * Every Flate stream is inflated, so objects in object streams are read too, as in
 * `links.annotations.compile.test.ts` (EXP-030).
 *
 * The positive control is a link annotation (`/Subtype /Link`), so the inspection is known to read
 * annotations. The fields themselves must print their values as text (criterion 1, so the document
 * is not empty), and the PDF must have no `/AcroForm` and no widget annotation.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

/** A `form_field` inline node with a fixed width of 2880 twips (144 pt). */
function field(key: string, kind: string, attrs: J = {}): J {
  return {
    type: 'form_field',
    attrs: { id: nid('ff'), key, kind, label: `Label ${key}`, width: 2880, value: null, ...attrs },
  };
}

/** A text node carrying a link mark, so the PDF has one link annotation (the positive control). */
function link(text: string, href: string): J {
  return { type: 'text', text, marks: [{ type: 'link', attrs: { href } }] };
}

/** The PDF as text: the raw file, then the inflated contents of every Flate stream. */
function pdfObjectText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  const parts = [raw];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const body = Buffer.from(raw.slice(start, end), 'latin1');
    try {
      parts.push(inflateSync(body).toString('latin1'));
    } catch {
      // Not a Flate stream, or not inflatable; its dictionary is still in the raw text.
    }
  }
  return parts.join('\n');
}

/** Keys and subtypes that only a live form (AcroForm, widget or field dictionary) carries. */
const LIVE_FORM = [
  /\/AcroForm\b/,
  /\/Subtype\s*\/Widget\b/,
  /\/FT\s*\/(Tx|Btn|Ch|Sig)\b/,
  /\/FT\s*\/[A-Za-z]+/,
];

describe.skipIf(!ready)('EXP-033 criterion 8: the compiled PDF has no live PDF form fields', () => {
  it('prints the flattened values and has no AcroForm, widget or field dictionary', async () => {
    const body = [
      para('Name: ', {}, [field('name', 'text', { value: 'Ada Lovelace' })]),
      para('Agree: ', {}, [field('agree', 'checkbox', { value: true })]),
      para('Amount: ', {}, [
        field('amount', 'number', {
          value: '1234.5',
          format: { decimals: 2, prefix: 'USD ', suffix: ' net' },
        }),
      ]),
      para('Site: ', {}, [link('Example', 'https://example.com/form')]),
    ];
    const c = await convertAndCompile(doc(body), {
      profile: 'final',
      title: 'exp-033-no-live-fields',
      instant: INSTANT,
      timeZone: 'Europe/London',
      suggestions: 'accept',
      fields: 'flatten',
    } as never);
    if (!c.compile.ok || !c.compile.pdf)
      throw new Error(
        `the compile failed (${keep('exp-033-no-live-fields', c)}):\n${c.compile.log.slice(-1500)}`,
      );
    const objects = pdfObjectText(c.compile.pdf);

    // Positive control: annotations are visible to this inspection.
    expect(objects).toMatch(/\/Subtype\s*\/Link\b/);

    // The flattened values are printed as text (so the fields were not simply dropped).
    const printed = pdfText(c.compile.pdf);
    if (printed !== null) {
      expect(printed).toContain('Ada Lovelace');
      expect(printed).toContain('USD 1234.50 net');
    }

    // Criterion 8: no live form, widget or field dictionary is present.
    for (const re of LIVE_FORM) expect(objects, `live form ${re}`).not.toMatch(re);
  }, 300_000);
});
