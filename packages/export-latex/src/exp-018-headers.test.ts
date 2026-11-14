/**
 * Headers and footers (Node.js only): EXP-018 criteria 1 to 4. The converter's side is read from
 * main.tex (`\DEdefsetupb`, `\DEdefsetupc` and `\DEdefstory`). The class's side is read from its
 * source with comments removed: the page style and the header measurement. Nothing compiles, so
 * the header that a PDF page shows, and the body position on it, are not inspected.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, run, type J } from '../test/docs.ts';

const CLASS = readFileSync(fileURLToPath(new URL('../class/docedit.cls', import.meta.url)), 'utf8');
const CLASS_CODE = CLASS.split('\n')
  .map((l) => l.replace(/(^|[^\\])%.*$/, '$1'))
  .join('\n');
const MAIN = 'main.tex';
const A4: J = {
  width: 11906,
  height: 16838,
  marginTop: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  marginRight: 1440,
  gutter: 0,
  headerDistance: 720,
  footerDistance: 720,
};

/** The arguments of `\<name>{k}{...}`, each a braced group without braces inside. */
function macroArgs(main: string, name: string, k: number): string[] {
  const m = new RegExp(`\\\\${name}\\{${k}\\}((?:\\{[^{}]*\\})+)`).exec(main);
  if (m === null) throw new Error(`no \\${name}{${k}}`);
  return [...m[1]!.matchAll(/\{([^{}]*)\}/g)].map((x) => x[1]!);
}

/** The body of the `\DEdefstory{k}{...}` macro whose number is k, up to its closing line. */
function storyBody(main: string, k: number): string {
  const start = main.indexOf(`\\DEdefstory{${k}}{%`);
  if (start < 0) throw new Error(`no story ${k}`);
  const end = main.indexOf('\n}', start);
  return main.slice(start, end < 0 ? undefined : end);
}

/** A header or footer story: a story node with the given paragraph content. */
const story = (id: string, text: string, extra: J[] = []): J => ({
  type: 'story',
  attrs: { id },
  content: [para(text, {}, extra)],
});

/** A page setup that names header and footer stories. */
const setup = (id: string, attrs: J = {}): J => ({
  type: 'page_setup',
  attrs: { id, ...A4, ...attrs },
});

describe('EXP-018 criterion 1 (not ticked): a page setup with default, first-page and even-page stories gives the variants', () => {
  it('writes the story numbers and the different-first-page and different-odd-even flags of the setup', async () => {
    const bundle = await run(
      doc([para('body')], {
        pageSetups: [
          setup('ps1', {
            headerDefault: 'hd',
            headerFirst: 'hf',
            headerEven: 'he',
            differentFirstPage: true,
            differentOddEven: true,
          }),
        ],
        stories: [story('hd', 'default'), story('hf', 'first'), story('he', 'even')],
      }),
    );
    const main = bundle.files[MAIN]!;
    const c = macroArgs(main, 'DEdefsetupc', 0);
    expect(c.slice(0, 3).every((v) => /^[1-9]\d*$/.test(v))).toBe(true);
    expect(new Set(c.slice(0, 3)).size).toBe(3);
    expect(c.slice(3)).toEqual(['0', '0', '0']);
    const b = macroArgs(main, 'DEdefsetupb', 0);
    // Order: footer distance, columns, column gap, first page, odd and even, page number start, format.
    expect(b.slice(3)).toEqual(['1', '1', '-1', '0']);
  });
});

describe('EXP-018 criterion 2: the class measures the header and footer and moves the body (header growth)', () => {
  it('measures the header stories at the text width and sets the body frame from the measured heights (class audit)', () => {
    expect(CLASS_CODE).toMatch(/\\DE@measure\{\\DE@ps\{#1\}\{hdef\}\}/);
    expect(CLASS_CODE).toMatch(/\\DE@measure\{\\DE@ps\{#1\}\{hfirst\}\}/);
    expect(CLASS_CODE).toMatch(/\\DE@measure\{\\DE@ps\{#1\}\{heven\}\}/);
    expect(CLASS_CODE).toMatch(/\\global\\DE@hh=\\DE@tmpd/);
    expect(CLASS_CODE).toMatch(/\\global\\headheight=\\DE@hh/);
    expect(CLASS_CODE).toMatch(/\\directlua\{docedit\.frame\(/);
  });
});

describe('EXP-018 criterion 3: a second setup with a different header replaces the first and does not leak back', () => {
  it('gives each setup its own header story number, and the class page style is redefined at each section start', async () => {
    const bundle = await run(
      doc(
        [
          para('a'),
          { type: 'section_break', attrs: { id: nid('s'), pageSetup: 'ps2', start: 'nextPage' } },
          para('b'),
        ],
        {
          pageSetups: [
            setup('ps1', { headerDefault: 'h1' }),
            setup('ps2', { headerDefault: 'h2' }),
          ],
          stories: [story('h1', 'first header'), story('h2', 'second header')],
        },
      ),
    );
    const main = bundle.files[MAIN]!;
    const h0 = macroArgs(main, 'DEdefsetupc', 0)[0]!;
    const h1 = macroArgs(main, 'DEdefsetupc', 1)[0]!;
    expect(h0).not.toBe(h1);
    expect(h0).not.toBe('0');
    expect(h1).not.toBe('0');
    expect(storyBody(main, Number(h0))).toContain('first header');
    expect(storyBody(main, Number(h1))).toContain('second header');
    // Each page style sets \@oddhead afresh, so a later setup replaces the earlier header (class audit).
    expect(CLASS_CODE).toMatch(/\\def\\DE@pagestyle#1#2\{[\s\S]*?\\def\\@oddhead\{/);
    expect(CLASS_CODE).toMatch(/\\let\\@evenhead\\@oddhead/);
  });
});

describe('EXP-018 criterion 4: a header with a page field prints the page field on the page that shows it', () => {
  it('writes \\DEpage into the header story and the class defines the page field and the page number', async () => {
    const pageField: J = { type: 'field', attrs: { id: nid('f'), kind: 'page' } };
    const bundle = await run(
      doc([para('body')], {
        pageSetups: [setup('ps1', { headerDefault: 'h1' })],
        stories: [story('h1', 'Page ', [pageField])],
      }),
    );
    const main = bundle.files[MAIN]!;
    const h = Number(macroArgs(main, 'DEdefsetupc', 0)[0]);
    expect(storyBody(main, h)).toContain('\\DEpage');
    expect(CLASS_CODE).toMatch(/\\newcommand\*\\DEpage\{\\thepage\}/);
    expect(CLASS_CODE).toMatch(/\\renewcommand\*\\thepage\{\\directlua\{docedit\.pagenumber\(/);
    // \DEpage is typeset inside the header macro, which the page style calls once per page.
    expect(CLASS_CODE).toMatch(/\\DE@story\{\\DE@pick\{#1\}\{h\}\{#2\}\}/);
  });
});
