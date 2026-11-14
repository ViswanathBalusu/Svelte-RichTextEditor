/**
 * EXP-043 criterion 1, checked on the compiled PDF (Node.js only, sandbox): a metadata field and an
 * alternative text reach the PDF as typed, so no TeX command in the input survives as a command.
 *
 * - The document title goes through `kvValue` into `\hypersetup{pdftitle=...}`; the XMP `dc:title` of
 *   the PDF must hold the title exactly as it was given.
 * - The alternative text of a figure with no picture goes through `pdfString` into its placeholder
 *   text; `pdftotext` must return the placeholder exactly as it was given.
 *
 * Bookmarks are not checked here (no outline reader is available to the test), so EXP-043 criterion 1
 * stays unticked; see the story's Notes.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

const OPTIONS = {
  profile: 'preview',
  instant: INSTANT,
  timeZone: 'Europe/London',
  suggestions: 'accept',
} as const;

/**
 * The document title as the PDF's XMP metadata stores it (`dc:title`, the first `x-default` item), or
 * null when there is no such item. With `\DocumentMetadata` in PDF 2.0 and PDF/UA the title is written
 * to XMP only; the Info dictionary has no `/Title` (observed in the sandbox, 2026-11-13).
 */
function xmpTitle(pdf: Uint8Array): string | null {
  const text = Buffer.from(pdf).toString('latin1');
  const m = /<dc:title>\s*<rdf:Alt>\s*<rdf:li xml:lang="x-default">([\s\S]*?)<\/rdf:li>/.exec(text);
  if (m === null || m[1] === undefined) return null;
  return m[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

describe.skipIf(!ready)(
  'EXP-043 criterion 1: a metadata field and alternative text come out of the PDF as typed',
  () => {
    // The title reaches the XMP metadata (dc:title) unchanged. The Info dictionary has no /Title in this
    // profile (see xmpTitle), so pdfinfo is not the reader here.
    it('writes the document title to the PDF metadata unchanged, with no TeX command run', async () => {
      const title = 'Report \\textbf{BOLD} (100%) \\input{x} & ^^5c #1 ~ $y$ ]';
      const c = await convertAndCompile(doc([para('body')]), { ...OPTIONS, title } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);
      expect(xmpTitle(c.compile.pdf)).toBe(title);
    }, 300_000);

    it('writes the alternative text of a figure without a picture unchanged, with no TeX command run', async () => {
      const alt = 'Map \\textbf{x} (100%) \\input{/etc/passwd} ^^5c';
      const figure: J = { type: 'figure', attrs: { id: nid('f'), width: 1440, height: 1440, alt } };
      const c = await convertAndCompile(doc([figure]), OPTIONS as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);
      const text = pdfText(c.compile.pdf);
      if (text === null) throw new Error('pdftotext is not installed or failed');
      expect(text).toContain(`[figure: ${alt}]`);
    }, 300_000);
  },
);
