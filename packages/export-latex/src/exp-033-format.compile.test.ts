/**
 * EXP-033 criterion 2, checked on the compiled PDF (Node.js only, sandbox; lane V-EXP-033-048):
 * a `number` field is printed with its decimals, prefix and suffix, a `date` field with its
 * pattern (in UTC, as the converter writes it), and a `choice` field by the option's label, not
 * its identifier. The text is read from the PDF with `pdftotext -raw`.
 *
 * The checkbox glyph is not compiled here: its glyph may not be in the fonts, and the check of
 * glyphs would then fail the job for a reason unrelated to the criterion.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

/** A form field inline node of the given kind, with a fixed width, a label and attributes. */
function field(key: string, kind: string, attrs: J = {}): J {
  return {
    type: 'form_field',
    attrs: { id: nid('ff'), key, kind, label: `Label ${key}`, width: 2880, value: null, ...attrs },
  };
}

/** The text of the compiled PDF, one page after another, with `pdftotext -raw`. */
function pdfText(pdf: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-format-'));
  const file = join(dir, 'main.pdf');
  writeFileSync(file, pdf);
  const r = spawnSync('pdftotext', ['-raw', file, '-'], { encoding: 'utf8', timeout: 60_000 });
  if (r.error || r.status !== 0) throw new Error('pdftotext is not installed or failed');
  return r.stdout;
}

const OPTIONS = {
  profile: 'final',
  title: 'exp-033-format',
  instant: INSTANT,
  timeZone: 'Europe/London',
  suggestions: 'accept',
  fields: 'flatten',
} as never;

describe.skipIf(!ready)(
  'EXP-033 criterion 2: number, date and choice values are printed in their format',
  () => {
    it('prints a number with its decimals, prefix and suffix, a date with its pattern, and a choice by its label', async () => {
      const body = [
        para('Amount: ', {}, [
          field('amount', 'number', {
            value: '1234.5',
            format: { decimals: 2, prefix: 'USD ', suffix: ' net' },
          }),
        ]),
        para('Dated: ', {}, [
          field('when', 'date', { value: '2026-03-05', format: { datePattern: 'dd/MM/yyyy' } }),
        ]),
        para('Colour: ', {}, [
          field('colour', 'choice', {
            value: 'r',
            options: [
              { id: 'r', label: 'Vermilion Red' },
              { id: 'g', label: 'Green' },
            ],
          }),
        ]),
      ];
      const c = await convertAndCompile(doc(body), OPTIONS);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);
      const text = pdfText(c.compile.pdf);
      // The number: two decimals (rounded half up), the prefix and the suffix.
      expect(text, text).toContain('USD 1234.50 net');
      // The date: the stored day in the pattern, not the stored form.
      expect(text, text).toContain('05/03/2026');
      expect(text, text).not.toContain('2026-03-05');
      // The choice: the option's label, and not its identifier.
      expect(text, text).toContain('Vermilion Red');
      expect(text.split(/\s+/)).not.toContain('r');
    }, 600_000);
  },
);
