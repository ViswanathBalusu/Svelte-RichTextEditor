/**
 * EXP-043 criterion 1, bookmarks part (Node.js only, sandbox, lane U-EXP-033-048): a heading's bookmark
 * title goes through `pdfString` (`\DEh`, blocks.ts), and the outline entry in the compiled PDF must
 * hold the heading's text exactly as typed, with no TeX command surviving as a command.
 *
 * The outline is read with `test/exp-023-pdf-links.ts` (the same reader as EXP-022).
 *
 * Observed (2026-11-14, Podman, preview profile): titles with `%`, parentheses, `&`, `#`, `~`, `$`, `]`,
 * `^^5c`, braces and `_` come out as typed. A title with a backslash (`\textbf{BOLD}`) loses the
 * backslash and the letter after it (`Plan extbf{BOLD}`), and a longer title with `\textbf` and `\input`
 * came out as mixed-width garbage in one run. Round 8 (lane U-EXP-033-048) found the likely cause: the
 * bookmark string is a PDF literal that is not escaped, so `\t` in `\textbf` reads as a tab. Doubling
 * the backslash in `\DE@strexp` fixes the outline but also changes the XMP title (raw text), so it was
 * reverted; the fix needs a separate path for the bookmark (EXP-043 Notes). The criterion's "PDF string
 * encoding" wording stays open as well.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { pdfLinks } from '../test/exp-023-pdf-links.ts';
import { convertAndCompile, keep, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

function heading(id: string, level: number): J {
  return {
    type: 'style_def',
    attrs: {
      id,
      kind: 'paragraph',
      name: `Heading ${level}`,
      builtIn: true,
      outlineLevel: level,
      bold: true,
    },
  };
}

async function outlineTitles(text: string): Promise<string[]> {
  const c = await convertAndCompile(
    doc([para(text, { style: 'H1' }), para('Body text.')], { styles: [heading('H1', 1)] }),
    {
      profile: 'preview',
      title: 'exp-043-bookmarks',
      instant: INSTANT,
      timeZone: 'Europe/London',
      suggestions: 'accept',
    } as never,
  );
  expect(
    c.compile.ok,
    `the compile failed (${keep('exp-043-bookmarks', c)}):\n${c.compile.log.slice(-1500)}`,
  ).toBe(true);
  expect(c.compile.pdf).not.toBeNull();
  return pdfLinks(c.compile.pdf!).outline.map((o) => o.title);
}

describe.skipIf(!ready)(
  'EXP-043 criterion 1 (bookmarks): a bookmark title comes out of the PDF as typed',
  () => {
    it('keeps the specials of a heading (no backslash) in the outline unchanged', async () => {
      const title = 'Plan (100%) & #1 ~ $y$ ] ^^5c {x} _a_';
      expect(await outlineTitles(title)).toEqual([title]);
    }, 300_000);

    // Known defect, see the header: the backslash of a TeX command is lost in the bookmark. Remove the
    // `.fails` when the bookmark prints the heading as typed.
    it.fails(
      'keeps a backslash command in a heading in the outline unchanged (known defect, EXP-043)',
      async () => {
        const title = 'Plan \\textbf{BOLD}';
        expect(await outlineTitles(title)).toEqual([title]);
      },
      300_000,
    );
  },
);
