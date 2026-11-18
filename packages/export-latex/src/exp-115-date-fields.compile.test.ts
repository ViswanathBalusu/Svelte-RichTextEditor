/**
 * EXP-115 criterion 1, field dates: every case of the model's shared fixture `date-fields.json`
 * run against the LaTeX writer. A paragraph holds a `date` field with the case's format, the
 * converter gets the case's `instant` and `timeZone` (the export job's, never the client's), the
 * class compiles it, and the PDF text must hold the text that the fixture expects. The case
 * without a time zone expects a `RangeError` from the model; the writer must then report an error
 * diagnostic and print no date.
 *
 * Node.js only; needs `lualatex`, the local font copy and `pdftotext` (`test/cdm-local-tex.ts`);
 * skips without them. Evidence:
 * `pnpm exec vitest run --project node packages/export-latex/src/exp-115-date-fields.compile.test.ts`
 * with `DOCEDIT_LUALATEX` and `DOCEDIT_PDFTOTEXT` set when they are not on the PATH.
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para } from '../test/docs.ts';
import { compileLocalAsync, convertLocal, lualatexAvailable } from '../test/cdm-local-tex.ts';
import { loadSemantics, pdfText, pdftotextAvailable, squash } from '../test/exp-115-fixtures.ts';

interface Case {
  readonly id: string;
  readonly instant: string;
  readonly timeZone: string | null;
  readonly format: string | null;
  readonly expected: string | { readonly error: string };
}

const CASES = loadSemantics<{ cases: Case[] }>('date-fields').cases;
const ready = lualatexAvailable() && pdftotextAvailable();

describe.skipIf(!ready)('EXP-115 criterion 1: field dates in the extracted PDF text', () => {
  for (const c of CASES) {
    it.concurrent(
      `[date-fields x LaTeX] ${c.id}`,
      async () => {
        const field = {
          type: 'field',
          attrs: { id: nid('f'), kind: 'date', ...(c.format === null ? {} : { format: c.format }) },
        };
        const options = {
          profile: 'preview',
          title: `exp-115-${c.id}`,
          instant: c.instant,
          ...(c.timeZone === null ? {} : { timeZone: c.timeZone }),
          suggestions: 'accept',
          layout: 'block',
        };
        const bundle = await convertLocal(doc([para('Dated: ', {}, [field])]), options as never);
        if (typeof c.expected !== 'string') {
          const error = bundle.diagnostics.find((d) =>
            ['date_without_job_time', 'date_field_invalid'].includes(d.code),
          );
          expect(error?.severity).toBe('error');
          return;
        }
        const compiled = await compileLocalAsync(bundle, `date-${c.id}`);
        if (!compiled.ok)
          throw new Error(`the compile failed (${compiled.dir}):\n${compiled.log.slice(-1500)}`);
        expect(squash(pdfText(compiled.pdf!))).toContain(`Dated: ${c.expected}`);
      },
      600_000,
    );
  }
});
