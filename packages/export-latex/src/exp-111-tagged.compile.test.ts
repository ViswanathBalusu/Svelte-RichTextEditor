/**
 * EXP-111 (Node.js, sandbox and veraPDF in Podman; lane U-EXP-097-112): the compiled PDF is
 * tagged and declares its standard, passes veraPDF, carries the document language, and is untagged
 * for `off`. Compiles run in the export worker's sandbox (EXP-070) and validation in the veraPDF
 * image (EXP-016). The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run.
 *
 * Criterion 5 (repeated headers and footers outside the reading order) and criterion 6 (field
 * labels) are not checked here; see the story's Notes.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import type { CdmEnvelope } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { doc, para } from '../test/docs.ts';
import { convertAndCompile, sandboxReady, validatePdf } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

/** A small document with a heading, two paragraphs and a table, typed in the CDM. */
function sample(): CdmEnvelope {
  return doc([
    para('Accessible report', { style: 'Heading1' }),
    para('First body paragraph with some text.'),
    para('Second body paragraph.'),
  ]);
}

const compile = async (name: string, envelope: CdmEnvelope, options: Record<string, unknown>) => {
  const c = await convertAndCompile(envelope, {
    profile: 'final',
    title: name,
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
    layout: 'block',
    ...options,
  } as never);
  if (!c.compile.ok || !c.compile.pdf) {
    throw new Error(`the compile of ${name} failed:\n${c.compile.log.slice(-1500)}`);
  }
  return c.compile.pdf;
};

/**
 * The PDF's objects as latin1 text: the file's own bytes, plus every Flate stream inflated (object
 * streams hold the catalogue and the metadata, which are compressed in a LuaTeX file).
 */
function asText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  const parts = [raw];
  let at = 0;
  for (;;) {
    const s = raw.indexOf('stream', at);
    if (s < 0) break;
    const end = raw.indexOf('endstream', s);
    if (end < 0) break;
    let start = s + 'stream'.length;
    if (raw[start] === '\r') start++;
    if (raw[start] === '\n') start++;
    try {
      parts.push(inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'));
    } catch {
      // Not a Flate stream (images, fonts in binary form): skipped.
    }
    at = end + 'endstream'.length;
  }
  return parts.join('\n');
}

describe.skipIf(!ready)(
  'EXP-111 criteria 1 and 2: a tagged PDF declares UA-2 and A-4f and passes veraPDF',
  () => {
    it('declares PDF/UA-2 and PDF/A-4f in the metadata, and both validate with veraPDF', async () => {
      const pdf = await compile('exp-111-ua2-a4f', sample(), {
        tagging: 'on',
        pdfStandard: 'ua-2+a-4f',
      });
      const text = asText(pdf);
      expect(text).toMatch(/<pdfuaid:part>2<\/pdfuaid:part>/);
      expect(text).toMatch(/<pdfaid:part>4<\/pdfaid:part>/);
      expect(text).toMatch(/\/StructTreeRoot/);
      const ua2 = await validatePdf(pdf, 'ua2');
      expect(ua2.error, 'the validator output parses').toBeUndefined();
      expect(ua2.failures, 'no PDF/UA-2 rule fails').toEqual([]);
      expect(ua2.compliant).toBe(true);
      const a4f = await validatePdf(pdf, '4f');
      expect(a4f.error, 'the validator output parses').toBeUndefined();
      expect(a4f.compliant).toBe(true);
    }, 600_000);
  },
);

describe.skipIf(!ready)('EXP-111 criterion 3: the document language is the PDF language', () => {
  it('sets /Lang to the document language of the settings', async () => {
    const pdf = await compile('exp-111-lang', sample(), { tagging: 'on', pdfStandard: 'none' });
    expect(asText(pdf)).toMatch(/\/Lang\s*\(en-GB\)/);
  }, 300_000);
});

describe.skipIf(!ready)(
  'EXP-111 criterion 4: off is untagged, draft is tagged in draft form',
  () => {
    it('writes no structure tree for tagging off', async () => {
      const pdf = await compile('exp-111-off', sample(), { tagging: 'off', pdfStandard: 'none' });
      expect(asText(pdf)).not.toMatch(/\/StructTreeRoot/);
    }, 300_000);

    it('marks the content with MCIDs for tagging draft, and writes no structure tree', async () => {
      // Draft tagging (tagpdf's draft mode) numbers the marked content but writes no structure tree.
      const pdf = await compile('exp-111-draft', sample(), {
        tagging: 'draft',
        pdfStandard: 'none',
      });
      expect(asText(pdf)).toMatch(/\/MCID\s+\d+/);
      expect(asText(pdf)).not.toMatch(/\/StructTreeRoot/);
    }, 300_000);
  },
);

describe.skipIf(!ready)(
  'EXP-111 criterion 2 on the corpus: the S4 fixture passes veraPDF as PDF/UA-2 and PDF/A-4f',
  () => {
    it('validates the 1-page S4 corpus document', async () => {
      const envelope = JSON.parse(
        readFileSync(
          new URL(
            '../../../services/export-worker/fixtures/s4-corpus/s4-01p.cdm.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as CdmEnvelope;
      const pdf = await compile('exp-111-s4-01p', envelope, {
        tagging: 'on',
        pdfStandard: 'ua-2+a-4f',
      });
      const ua2 = await validatePdf(pdf, 'ua2');
      expect(ua2.failures, 'no PDF/UA-2 rule fails').toEqual([]);
      expect(ua2.compliant).toBe(true);
      const a4f = await validatePdf(pdf, '4f');
      expect(a4f.compliant).toBe(true);
    }, 600_000);
  },
);
