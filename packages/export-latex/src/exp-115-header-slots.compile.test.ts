/**
 * EXP-115 criterion 1, header and footer slots: the `slots` of the model's shared fixture
 * `header-growth.json` run against the LaTeX writer, read in the compiled PDF. (The body start of
 * the `frames` runs in `cdm-045-header-growth.test.ts`; the body end in
 * `exp-115-body-end.compile.test.ts`.)
 *
 * A case gives a page setup and, for pages described by "first page of its section" and "even", the
 * header and footer story the page shows (null: none, with no fall back to the default slot). Each
 * story is one paragraph with a marker word of its own. For each described page the test builds a
 * document in which that page exists, compiles it, and reads the text of the page with `pdftotext`:
 * the markers on the page must be the ones the fixture names, and no other.
 *
 * - first of its section, odd: page 1 of a document with the case's setup;
 * - first of its section, even: a plain first section of one page, then a section break to the
 *   case's setup (page 2);
 * - not first, even: page 2 of a section of two pages; not first, odd: page 3 of one of three.
 *
 * Node.js only; needs `lualatex`, the local font copy and `pdftotext` (`test/cdm-local-tex.ts`);
 * skips without them. Evidence:
 * `pnpm exec vitest run --project node packages/export-latex/src/exp-115-header-slots.compile.test.ts`
 * with `DOCEDIT_LUALATEX` and `DOCEDIT_PDFTOTEXT` set when they are not on the PATH.
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { compileLocalAsync, convertLocal, lualatexAvailable } from '../test/cdm-local-tex.ts';
import { loadSemantics, pdftotextAvailable } from '../test/exp-115-fixtures.ts';
import { pdfText } from '../test/harness.ts';

interface Page {
  readonly firstOfSection: boolean;
  readonly even: boolean;
  readonly header: string | null;
  readonly footer: string | null;
}
interface Case {
  readonly id: string;
  readonly description: string;
  readonly pageSetup: Readonly<Record<string, unknown>>;
  readonly pages: readonly Page[];
}

const CASES = loadSemantics<{ slots: Case[] }>('header-growth').slots;
const ready = lualatexAvailable() && pdftotextAvailable();

const A4: Record<string, number> = {
  width: 11906,
  height: 16838,
  marginTop: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  marginRight: 1440,
  gutter: 0,
  headerDistance: 708,
  footerDistance: 708,
};

/** The marker word of a story: `Marker` and the letter after `story` in its identifier. */
const marker = (id: string): string => `Marker${id.slice('story'.length, 'story'.length + 1)}`;

const storyIds = (c: Case): string[] => [
  ...new Set(Object.values(c.pageSetup).filter((v): v is string => typeof v === 'string')),
];

/** The text of the page under test (1-based index) of a document that has the case's setup on it. */
async function pageText(c: Case, page: Page, name: string): Promise<string> {
  const stories: J[] = storyIds(c).map((id) => ({
    type: 'story',
    attrs: { id },
    content: [para(marker(id))],
  }));
  const plain: J = { type: 'page_setup', attrs: { id: 'psPlain', ...A4 } };
  const caseSetup: J = { type: 'page_setup', attrs: { id: 'psCase', ...A4, ...c.pageSetup } };
  const filler = (n: number): J[] =>
    Array.from({ length: n }, (_, i) => para(`Body page ${i + 1}.`, { pageBreakBefore: i > 0 }));
  let body: J[];
  let bodySetup = 'psCase';
  let index: number;
  if (page.firstOfSection && !page.even) {
    body = filler(1);
    index = 1;
  } else if (page.firstOfSection) {
    // The case's section starts on page 2: a plain section of one page comes first.
    bodySetup = 'psPlain';
    body = [
      para('Before the section.'),
      { type: 'section_break', attrs: { id: nid('s'), pageSetup: 'psCase', start: 'nextPage' } },
      para('First page of the section.'),
    ];
    index = 2;
  } else if (page.even) {
    body = filler(2);
    index = 2;
  } else {
    body = filler(3);
    index = 3;
  }
  const envelope = doc(body, {
    pageSetups: [plain, caseSetup],
    stories,
  });
  // `doc` gives the body the first page setup of the list; the case that starts a section later
  // needs the plain one first, the others the case's.
  const content = (envelope.doc as { content: J[] }).content;
  const bodyNode = content.find((n) => n['type'] === 'body')!;
  (bodyNode['attrs'] as J)['pageSetup'] = bodySetup;
  const bundle = await convertLocal(envelope, {
    profile: 'preview',
    title: `exp-115-${name}`,
    instant: '2026-11-06T10:00:00.000Z',
    timeZone: 'Europe/London',
    suggestions: 'accept',
    layout: 'block',
    assets: {},
  } as never);
  const compiled = await compileLocalAsync(bundle, name);
  if (!compiled.ok || !compiled.pdf)
    throw new Error(`the compile failed (${compiled.dir}):\n${compiled.log.slice(-1500)}`);
  const text = pdfText(compiled.pdf);
  if (text === null) throw new Error('pdftotext failed');
  const pages = text.split('\f');
  return pages[index - 1] ?? '';
}

describe.skipIf(!ready)('EXP-115 criterion 1: header and footer slots read in the PDF', () => {
  for (const c of CASES) {
    c.pages.forEach((page, n) => {
      const where = `${page.firstOfSection ? 'first' : 'later'} page of its section, ${page.even ? 'even' : 'odd'}`;
      it.concurrent(
        `[header-growth x LaTeX] slots ${c.id}: the ${where} shows header ${page.header ? marker(page.header) : 'none'} and footer ${page.footer ? marker(page.footer) : 'none'}`,
        async () => {
          const text = await pageText(c, page, `slots-${c.id}-${n}`);
          const shown = storyIds(c)
            .map(marker)
            .filter((m) => text.includes(m))
            .sort();
          const expected = [page.header, page.footer]
            .filter((id): id is string => id !== null)
            .map(marker)
            .sort();
          expect(shown, `the markers on the page (${c.description})`).toEqual(expected);
        },
        600_000,
      );
    });
  }
});
