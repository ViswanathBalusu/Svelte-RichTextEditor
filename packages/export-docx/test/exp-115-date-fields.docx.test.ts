/**
 * EXP-115 criterion 2, field dates: every case of the model's shared fixture `date-fields.json`
 * run against the DOCX writer. A paragraph holds a `date` field with the case's format, the
 * writer gets the case's `instant` and `timeZone` (the export job's, never the client's), and the
 * result text stored in the field (what Word shows until someone updates it) must be the text the
 * fixture expects. The field is locked (`w:fldLock`) so that Word does not replace the server's
 * date with the reader's. The case without a time zone expects a `RangeError` from the model: the
 * writer must then warn and store no date.
 *
 * Plain Node.js, no Word needed, so it runs in CI. What it does not show: how Word itself formats
 * the picture of an unlocked field, which is the reader's date and not a fixture.
 */
import { describe, expect, it } from 'vitest';
import type { JsonEnvelope } from '@docedit/model';
import { AssetStore, entryData, readZip } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';
import { type DefsFile, loadSemantics } from './exp-115-word.ts';

interface Case {
  readonly id: string;
  readonly instant: string;
  readonly timeZone: string | null;
  readonly format: string | null;
  readonly expected: string | { readonly error: string };
}

const CASES = loadSemantics<{ cases: Case[] } & DefsFile>('date-fields').cases;

function envelopeOf(format: string | null): JsonEnvelope {
  const field = {
    type: 'field',
    attrs: { id: 'f01xxxxxxxxxxxxx', kind: 'date', ...(format === null ? {} : { format }) },
  };
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: {} },
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'p01xxxxxxxxxxxxx' },
              content: [{ type: 'text', text: 'Dated: ' }, field],
            },
          ],
        },
      ],
    },
  } as unknown as JsonEnvelope;
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('EXP-115 criterion 2: field dates in the DOCX package', () => {
  for (const c of CASES) {
    it(`[date-fields x DOCX] ${c.id}`, async () => {
      const out = await writeDocx(envelopeOf(c.format), new AssetStore(), {
        instant: c.instant,
        ...(c.timeZone === null ? {} : { timeZone: c.timeZone }),
      });
      const zip = readZip(out.bytes);
      const entry = zip.entries.find((e) => e.name === 'word/document.xml')!;
      const xml = text(entryData(zip, entry));
      const field =
        /<w:fldChar w:fldCharType="begin"[^>]*\/>.*?<w:fldChar w:fldCharType="end"\/>/s.exec(
          xml,
        )?.[0];
      expect(field, 'the paragraph holds a complex field').toBeDefined();
      expect(field).toContain('DATE \\@');
      const result =
        /<w:fldChar w:fldCharType="separate"\/><\/w:r><w:r>(?:<w:rPr>.*?<\/w:rPr>)?<w:t[^>]*>([^<]*)<\/w:t>/s.exec(
          field!,
        )?.[1] ?? '';
      if (typeof c.expected !== 'string') {
        expect(result).toBe('');
        expect(out.warnings.some((w) => /date field/.test(w))).toBe(true);
        return;
      }
      expect(result).toBe(c.expected);
      expect(field).toContain('w:fldLock="1"');
    });
  }
});
