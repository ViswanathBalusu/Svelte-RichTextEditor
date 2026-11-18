/**
 * EXP-043 criterion 1, bookmarks part (Node.js only, sandbox, lane U-EXP-033-048): a heading's bookmark
 * title goes through `pdfString` (`\DEh`, blocks.ts), and the outline entry in the compiled PDF must
 * hold the heading's text exactly as typed, with no TeX command surviving as a command.
 *
 * The outline is read with `test/exp-023-pdf-links.ts` (the same reader as EXP-022).
 *
 * Observed (2026-11-14, Podman, preview profile): titles with `%`, parentheses, `&`, `#`, `~`, `$`, `]`,
 * `^^5c`, braces and `_` come out as typed. A title with a backslash (`	extbf{BOLD}`) lost the backslash
 * and the letter after it (`Plan extbf{BOLD}`) until class 0.2.14: hyperref read the catcode-12
 * backslash as the start of an escape. `docedit.strexp` (`DE@strexp`, used where `pdfstringdef` builds
 * a bookmark title) now writes it as `	extbackslash` (owner decision 209; EXP-022 criterion 2).
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

    // The backslash of a TeX command was lost in the bookmark until class 0.2.14 (`docedit.strexp`).
    it('keeps a backslash command in a heading in the outline unchanged (fixed in class 0.2.14)', async () => {
      const title = 'Plan \\textbf{BOLD}';
      expect(await outlineTitles(title)).toEqual([title]);
    }, 300_000);
  },
);
