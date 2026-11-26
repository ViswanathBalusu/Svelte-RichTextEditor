/**
 * Export options to a compile (09 §8, §9.1; EXP-061, EXP-062; ADR 0045): profiles, tagging and
 * standards, and options that cannot be honoured fail instead of being dropped.
 */
import { describe, expect, it } from 'vitest';
import { formatJobDate, planJob } from './profile.ts';

const plan = (options: unknown, lang: string | null = 'en-GB') => {
  const r = planJob(options, lang);
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join('; '));
  return r.plan;
};
const refused = (options: unknown) => {
  const r = planJob(options, 'en-GB');
  return r.ok ? [] : r.diagnostics.map((d) => d.code);
};

describe('profiles (EXP-061, EXP-062)', () => {
  it('runs a final export to convergence with full tagging by default', () => {
    expect(plan(undefined)).toMatchObject({
      profile: 'final',
      tagging: 'on',
      pdfStandard: 'ua-2+a-4f',
      minPasses: 2,
      maxPasses: 4,
    });
  });

  it('runs a preview in one pass with tagging off, which keeps the final breaks (S4 §4.4)', () => {
    expect(plan({ profile: 'preview' })).toMatchObject({
      profile: 'preview',
      tagging: 'off',
      pdfStandard: 'none',
      minPasses: 1,
      maxPasses: 1,
    });
    // A requested tagging mode wins over the profile's default.
    expect(plan({ profile: 'preview', tagging: 'draft' }).tagging).toBe('draft');
  });

  it('declares PDF/A-4f for PDF/A-4, with a warning, and refuses PDF/UA-2 without tagging', () => {
    const p = plan({ pdfStandard: 'a-4' });
    expect(p.pdfStandard).toBe('a-4f');
    expect(p.diagnostics.map((d) => d.code)).toEqual(['pdf_standard_substituted']);
    expect(plan({ pdfStandard: 'ua-2' }).pdfStandard).toBe('ua-2');
    expect(refused({ pdfStandard: 'ua-2', tagging: 'off' })).toEqual(['option_unsupported']);
  });

  it('refuses options it cannot honour and values outside the schema', () => {
    // The margin is a page's: margin comments are for pdf and tex (EXP-084), not html or md.
    expect(refused({ comments: 'margin' })).toEqual(['option_unsupported']);
    expect(refused({ comments: 'side' })).toEqual(['option_invalid']);
    // Suggestion markup is honoured since EXP-083 (export-latex suggestions.ts).
    expect(refused({ suggestions: 'markup' })).toEqual([]);
    expect(refused({ suggestions: 'inline' })).toEqual(['option_invalid']);
    expect(refused({ certificate: true })).toEqual(['option_unsupported']);
    expect(refused({ profile: 'draft' })).toEqual(['option_invalid']);
    expect(refused({ tagging: 'full' })).toEqual(['option_invalid']);
    expect(refused({ pdfStandard: 'x-1' })).toEqual(['option_invalid']);
    expect(refused({ timeZone: 'Mars/Olympus' })).toEqual(['option_invalid']);
    expect(refused({ locale: '<script>' })).toEqual(['option_invalid']);
  });

  it('passes fields and suggestions on, and notes options it does not know', () => {
    expect(plan({ fields: 'blank', suggestions: 'reject' })).toMatchObject({
      fields: 'blank',
      suggestions: 'reject',
    });
    expect(plan({ suggestions: 'markup' }).suggestions).toBe('markup');
    const p = plan({ preamble: '\\usepackage{x}' });
    expect(p.diagnostics).toEqual([expect.objectContaining({ code: 'option_ignored' })]);
    expect(p.diagnostics[0]!.message).not.toContain('\\');
  });

  it("uses the document's language and UTC when the request names none", () => {
    expect(plan(undefined, 'de-DE')).toMatchObject({ locale: 'de-DE', timeZone: 'UTC' });
    expect(plan(undefined, null)).toMatchObject({ locale: 'en-GB', timeZone: 'UTC' });
    const at = Date.UTC(2026, 10, 6, 23, 30);
    expect(formatJobDate(at, { locale: 'en-GB', timeZone: 'UTC' })).toBe('6 November 2026');
    expect(formatJobDate(at, { locale: 'en-GB', timeZone: 'Asia/Tokyo' })).toBe('7 November 2026');
  });
});
