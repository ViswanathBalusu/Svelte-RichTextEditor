/**
 * EXP-115 criterion 2, header growth and header slots, DOCX side (EXP-090 criterion 6): the `frames`
 * and the `slots` of the model's shared fixture `header-growth.json` written by `writeDocx`, laid out
 * by Microsoft Word 16 and measured in the PDF it exports (`pdftotext -bbox`).
 *
 * Frames. Each case is a document with the case's page setup and a header and a footer story whose
 * paragraph has an exact line height of `headerHeight` and `footerHeight` twips (the story is as
 * high as the fixture says). The body is a run of one-word lines of an exact height of 60 twips.
 * The top of the body is the first body word's distance from the one in a reference document of the
 * same page setup with no header and no footer, whose body starts at the top margin. The bottom
 * follows from how many lines fit on page 1 against the reference (a line is 60 twips, so the bottom
 * is known to a line). `startsOnPage` is the page of the first body line. Word's PDF export places
 * text on a grid of about 0.12 pt (2.4 twips), so a top is compared within 5 twips, and the case
 * `header-one-twip-over` (one twip over the margin) cannot tell its push from none: its push is not
 * asserted, its top is.
 *
 * Slots. Each case is a document of two sections, of three and two pages, that use one page setup, so
 * that the pages are: 1 first of its section and odd, 2 even, 3 odd, 4 first of the second section
 * and even, 5 odd. A story's paragraph is its own id, so that the PDF page names the story it shows.
 * For every page of the case's `pages`, the header and the footer printed on it are the fixture's
 * (a null slot prints none).
 *
 * Node.js only, Windows with Word and `pdftotext`; skips without them (CI has no Word).
 * Evidence: `pnpm exec vitest run --project node packages/export-docx/test/exp-115-header-growth.word.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  type J,
  documentOf,
  layOutInWord,
  loadSemantics,
  wordAvailable,
  wordsOf,
} from './exp-115-word.ts';

interface Frame {
  id: string;
  description: string;
  pageSetup: J;
  headerHeight: number;
  footerHeight: number;
  expected: {
    top?: number;
    bottom?: number;
    height?: number;
    headerPushes?: boolean;
    footerPushes?: boolean;
    startsOnPage?: number;
  };
}
interface Slot {
  id: string;
  description: string;
  pageSetup: J;
  pages: { firstOfSection: boolean; even: boolean; header: string | null; footer: string | null }[];
}

const FILE = loadSemantics<{ frames: Frame[]; slots: Slot[] }>('header-growth');
const DIR = 'exp-115-header-growth';
const LINE = 60;
const LINES = 300;
const TOL_TWIPS = 5;
const A4 = { width: 11906, height: 16838, marginTop: 1440, marginBottom: 1440 };
/**
 * Frames where Word differs from the fixture, with the reason. Each is asserted to still behave as
 * stated, so that a change on either side shows. The owner has not ruled on these (decision 77 gives
 * the fixture's rule and Word cannot be told to follow it), so the fixture is not changed and the
 * criterion stays open.
 */
const WORD_DIFFERS: Readonly<
  Record<string, { reason: string; startsOnPage: number; lines: number }>
> = {
  'nothing-left-for-the-body': {
    reason:
      'Word starts the body at the top the fixture gives (9708 twips) and prints one line there on page 1; the fixture (owner decision 77) starts the body on page 2 when no room is left.',
    startsOnPage: 1,
    lines: 1,
  },
};
const ready = wordAvailable();

let seq = 0;
const nid = (p: string): string => `${p}${String(++seq).padStart(16, 'x')}`.slice(0, 16);

const tiny = (text: string): J => ({
  type: 'text',
  text,
  marks: [{ type: 'fontSize', attrs: { value: 40 } }],
});
const line = (text: string, height: number): J => ({
  type: 'paragraph',
  attrs: { id: nid('p'), spaceBefore: 0, spaceAfter: 0, lineSpacing: height, lineRule: 'exact' },
  content: [tiny(text)],
});
const story = (id: string, kind: 'header' | 'footer', content: J[]): J => ({
  type: 'story',
  attrs: { id, kind },
  content,
});

/** A document with the page setup `ps` (attributes of `ps1`), stories and a body. */
function documentWith(name: string, ps: J, stories: J[], body: J[]) {
  const env = documentOf({}, { id: name, description: name, stories, body });
  const defs = (env.doc as unknown as { content: J[] }).content[0]!;
  const node = (defs['content'] as J[]).find((n) => n['type'] === 'page_setup')!;
  node['attrs'] = { ...(node['attrs'] as J), ...ps };
  return env;
}

const frameBody = (): J[] =>
  Array.from({ length: LINES }, (_, i) => line(`L${String(i + 1).padStart(4, '0')}`, LINE));

function frameDoc(f: Frame, reference: boolean) {
  const ps: J = { ...f.pageSetup };
  const stories: J[] = [];
  if (!reference && f.headerHeight > 0) {
    ps['headerDefault'] = 'hdrframexxxxxxxxx';
    stories.push(story('hdrframexxxxxxxxx', 'header', [line('HDR', f.headerHeight)]));
  }
  if (!reference && f.footerHeight > 0) {
    ps['footerDefault'] = 'ftrframexxxxxxxxx';
    stories.push(story('ftrframexxxxxxxxx', 'footer', [line('FTR', f.footerHeight)]));
  }
  return documentWith(`${f.id}${reference ? '-ref' : ''}`, ps, stories, frameBody());
}

/** The body words (L0001, ...) of a laid-out document, in order, with their page and y. */
function bodyWords(name: string) {
  return wordsOf(DIR, name).filter((w) => /^L\d{4}$/.test(w.text));
}

const SLOT_PAGES = [
  { n: 1, firstOfSection: true, even: false },
  { n: 2, firstOfSection: false, even: true },
  { n: 3, firstOfSection: false, even: false },
  { n: 4, firstOfSection: true, even: true },
  { n: 5, firstOfSection: false, even: false },
] as const;

function slotDoc(s: Slot) {
  const stories: J[] = [];
  const ps: J = { ...s.pageSetup };
  for (const [key, value] of Object.entries(s.pageSetup))
    if (/^(header|footer)(First|Even|Default)$/.test(key) && typeof value === 'string')
      stories.push(
        story(value, key.startsWith('header') ? 'header' : 'footer', [line(value, 200)]),
      );
  const page = (n: number): J => ({
    type: 'paragraph',
    attrs: { id: nid('p'), spaceBefore: 0, spaceAfter: 0 },
    content: [
      { type: 'text', text: `Page${n}` },
      ...(n === 3 || n === 5 ? [] : [{ type: 'break', attrs: { kind: 'page' } }]),
    ],
  });
  const body: J[] = [
    page(1),
    page(2),
    page(3),
    { type: 'section_break', attrs: { id: nid('s'), pageSetup: 'ps1', start: 'nextPage' } },
    page(4),
    page(5),
  ];
  return documentWith(s.id, ps, stories, body);
}

describe.skipIf(!ready)(
  'EXP-115 criterion 2: header growth and slots as Word lays them out',
  () => {
    let made: Promise<void> | undefined;
    const laidOut = (): Promise<void> =>
      (made ??= (async () => {
        const docs = new Map<string, { env: ReturnType<typeof documentWith> }>();
        for (const f of FILE.frames) {
          docs.set(`frame-${f.id}`, { env: frameDoc(f, false) });
          docs.set(`frame-${f.id}-ref`, { env: frameDoc(f, true) });
        }
        for (const s of FILE.slots) docs.set(`slots-${s.id}`, { env: slotDoc(s) });
        await layOutInWord(DIR, docs);
      })());

    describe('[header-growth x DOCX] frames', () => {
      for (const f of FILE.frames) {
        it(`[header-growth x DOCX] frame ${f.id}${WORD_DIFFERS[f.id] ? ' (Word differs from the fixture)' : ''}`, async () => {
          await laidOut();
          const ps = { ...A4, ...f.pageSetup } as {
            height: number;
            marginTop: number;
            marginBottom: number;
          };
          const words = bodyWords(`frame-${f.id}`);
          const ref = bodyWords(`frame-${f.id}-ref`);
          const first = words[0];
          expect(first, `${f.id}: a body line is printed`).toBeTruthy();
          const startsOnPage = first!.page;
          const differs = WORD_DIFFERS[f.id];
          expect(
            startsOnPage,
            `${f.id}: the page of the first body line. ${differs?.reason ?? ''}`,
          ).toBe(differs ? differs.startsOnPage : (f.expected.startsOnPage ?? 1));
          if (differs)
            expect(words.filter((w) => w.page === startsOnPage).length, differs.reason).toBe(
              differs.lines,
            );
          // Top of the body on its first page, against the reference whose body starts at the margin.
          const refTop = ref[0]!;
          const top = ps.marginTop + (first!.yMin - refTop.yMin) * 20;
          if (f.expected.top !== undefined)
            expect(
              Math.abs(top - f.expected.top),
              `${f.id}: Word's body starts at ${top.toFixed(1)} twips, the fixture says ${f.expected.top}`,
            ).toBeLessThanOrEqual(TOL_TWIPS);
          // Bottom: the lines that fit on the page the body starts on, against the reference.
          if (f.expected.bottom !== undefined && f.expected.height !== 0 && !differs) {
            const n = words.filter((w) => w.page === startsOnPage).length;
            const nRef = ref.filter((w) => w.page === 1).length;
            const bottom = ps.height - ps.marginBottom - (nRef - n) * LINE + (top - ps.marginTop);
            expect(
              Math.abs(bottom - f.expected.bottom),
              `${f.id}: Word's body ends near ${bottom} twips (to a line of ${LINE}), the fixture says ${f.expected.bottom}`,
            ).toBeLessThanOrEqual(LINE + TOL_TWIPS);
          }
          const pushedBy = top - ps.marginTop;
          if (f.expected.headerPushes !== undefined && f.id !== 'header-one-twip-over')
            expect(pushedBy > TOL_TWIPS, `${f.id}: the header pushes the body`).toBe(
              f.expected.headerPushes,
            );
        }, 900_000);
      }
    });

    describe('[header-growth x DOCX] slots', () => {
      for (const s of FILE.slots) {
        it(`[header-growth x DOCX] slots ${s.id}`, async () => {
          await laidOut();
          const words = wordsOf(DIR, `slots-${s.id}`);
          const stories = Object.entries(s.pageSetup)
            .filter(
              ([k, v]) => /^(header|footer)(First|Even|Default)$/.test(k) && typeof v === 'string',
            )
            .map(([k, v]) => ({
              kind: k.startsWith('header') ? 'header' : 'footer',
              id: v as string,
            }));
          const printed = (page: number, kind: string): string[] =>
            stories
              .filter(
                (x) => x.kind === kind && words.some((w) => w.page === page && w.text === x.id),
              )
              .map((x) => x.id);
          const wrong: string[] = [];
          for (const want of s.pages) {
            const pages = SLOT_PAGES.filter(
              (p) => p.firstOfSection === want.firstOfSection && p.even === want.even,
            );
            for (const p of pages) {
              const header = printed(p.n, 'header');
              const footer = printed(p.n, 'footer');
              const wantHeader = want.header === null ? [] : [want.header];
              const wantFooter = want.footer === null ? [] : [want.footer];
              if (JSON.stringify(header) !== JSON.stringify(wantHeader))
                wrong.push(
                  `page ${p.n}: header ${JSON.stringify(header)}, fixture ${JSON.stringify(wantHeader)}`,
                );
              if (JSON.stringify(footer) !== JSON.stringify(wantFooter))
                wrong.push(
                  `page ${p.n}: footer ${JSON.stringify(footer)}, fixture ${JSON.stringify(wantFooter)}`,
                );
            }
          }
          expect(wrong).toEqual([]);
          expect(
            words.some((w) => w.page === 5),
            'the document has five pages',
          ).toBe(true);
        }, 900_000);
      }
    });
  },
);
