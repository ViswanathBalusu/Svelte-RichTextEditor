/**
 * EXP-115 criterion 2, numbering labels: the model's shared fixtures `numbering-lists.json`,
 * `numbering-sequences.json`, `numbering-references.json` and `numbering-footnotes.json` run
 * against the DOCX writer. Each case is written by `writeDocx`, Word counts the labels itself
 * (native numbering, owner decision 215), fields are updated, Word exports the PDF, and the labels
 * the fixture expects are looked for in the text `pdftotext` extracts, as the LaTeX runner does
 * (`packages/export-latex/src/exp-115-numbering.compile.test.ts`).
 *
 * Needs Microsoft Word on Windows and `pdftotext` (`DOCEDIT_PDFTOTEXT` when not on the PATH);
 * skipped without them. Cases where Word counts differently from the model are listed in
 * `WORD_DIFFERS` with the reason, so that a new difference turns the run red.
 */
import { describe, expect, it } from 'vitest';
import {
  type DefsFile,
  type DocCase,
  type J,
  dense,
  documentOf,
  findById,
  layOutInWord,
  loadSemantics,
  nodesOf,
  pdfTextOf,
  printedText,
  wordAvailable,
} from './exp-115-word.ts';

interface Expected {
  lists?: { id: string; text: string; kind?: string }[];
  sequences?: { holder: string; texts: string[] }[];
  equations?: { id: string; text: string }[];
  footnotes?: { id: string; text: string }[];
  references?: { target: string; text: string | null }[];
}
interface Case extends DocCase {
  expected: Expected;
  valid?: boolean;
}
interface File extends DefsFile {
  cases: Case[];
}

const FILES = [
  'numbering-lists',
  'numbering-sequences',
  'numbering-references',
  'numbering-footnotes',
] as const;

/**
 * Cases whose labels differ in Word from the fixture, with the reason. Each was seen in Word 16
 * (Microsoft 365) on Windows 11 on 2026-11-18, by reading the PDF text of the case (the work
 * folder `test-results/exp-115-<fixture>-<pid>-<time>/`). A case that starts to pass turns the
 * run red, so the list cannot go stale. Not a pass: criterion 2 of EXP-115 stays open until the
 * list is empty or the owner accepts a difference (ADR 0032).
 */
const WORD_DIFFERS: Readonly<Record<string, string>> = {
  'numbering-lists/skipped-level':
    'A skipped level counts from its start in Word (1.1.1), from start - 1 in the model (1.0.1).',
  'numbering-lists/skipped-level-with-start': 'As skipped-level, with a start of 5.',
  'numbering-lists/skipped-level-start-zero':
    'As skipped-level, for a start of 0 (1.0.1 shows 1.1.1).',
  'numbering-lists/headings-numbered-by-style':
    'As skipped-level, for a heading style that skips a level.',
  'numbering-lists/template-names-deeper-level':
    'Word prints no label at all for a template that names a level not yet counted; the model shows start - 1.',
  'numbering-lists/template-names-missing-level':
    'Word prints no label when the template names a level the definition lacks; the model replaces the placeholder with nothing.',
  'numbering-lists/zero-in-every-format':
    'Letters and Roman numerals have no zero: Word prints nothing for a value of 0 (a letter list shows `a` for 1), the model prints 0.',
  'numbering-lists/restart-at-a-deeper-level':
    'Word shows `d)` for the first item of level 2 after the second item of level 1, the model `a)`; the cause in the written numbering.xml is not found.',
  'numbering-lists/one-list-two-definitions':
    'Two definitions cannot share counters in Word (CDM-005 Notes); each counts alone.',
  'numbering-sequences/equations-share-the-equation-sequence':
    'Word prints the second numbered equation as (3), the model as (2).',
  'numbering-sequences/field-inside-a-footnote':
    'Word does not update a SEQ field in a footnote: it prints "Error! Main Document Only."',
  'numbering-sequences/numbered-paragraph-inside-a-footnote':
    'Word counts a numbered paragraph in a footnote on its own (1.), the model continues the body list (2.).',
  'numbering-references/numbered-paragraph':
    'REF \\w drops the trailing full stop of a label: Word prints `2`, the model `2.`.',
  'numbering-references/table-caption':
    'REF \\w on the bookmark of a SEQ caption prints 0: the writer needs a bookmark round the number and a REF without \\w.',
  'numbering-references/figure-bookmark':
    'The reference to a figure bookmark prints nothing in Word.',
  'numbering-references/bookmark-in-a-footnote':
    'The reference to a bookmark inside a footnote prints nothing in Word.',
  'numbering-references/equation':
    'The references to equation labels print 0 and "Error! Reference source not found." in Word.',
  'numbering-footnotes/lower-roman':
    'The writer does not write the footnote number format: Word prints 1, 2, 3, the model i, ii, iii.',
  'numbering-footnotes/symbols': 'As lower-roman: Word prints 1, 2, 3, the model * and a dagger.',
};

function piecesOf(c: Case): string[] {
  const body = (c.body ?? []) as J[];
  const pieces: string[] = [];
  for (const l of c.expected.lists ?? []) {
    const p = findById(body, l.id);
    if (!p) continue;
    const text = printedText(p, () => '');
    pieces.push(l.kind === 'none' ? text : `${l.text}${text}`);
  }
  for (const s of c.expected.sequences ?? []) {
    const holder = findById(body, s.holder);
    if (!holder) continue;
    let i = 0;
    pieces.push(printedText(holder, () => s.texts[i++] ?? ''));
  }
  for (const f of c.expected.footnotes ?? []) {
    const fn = findById(body, f.id);
    if (!fn) continue;
    const note = [...nodesOf(fn)].filter((n) => n['type'] === 'paragraph');
    pieces.push(`${f.text}${note.map((p) => printedText(p, () => '')).join('')}`);
  }
  for (const r of c.expected.references ?? []) {
    const holder = body
      .flatMap((b) => [...nodesOf(b)])
      .find(
        (n) =>
          n['type'] === 'paragraph' &&
          [...nodesOf(n)].some(
            (f) =>
              f['type'] === 'field' &&
              ['ref', 'styleRef'].includes((f['attrs'] as J)['kind'] as string) &&
              (f['attrs'] as J)['target'] === r.target,
          ),
      );
    if (!holder) continue;
    const all = c.expected.references ?? [];
    pieces.push(
      printedText(holder, (f) => {
        const target = (f['attrs'] as J)['target'] as string;
        if ((f['attrs'] as J)['kind'] === 'styleRef') {
          const style = target.replace(/^style:/, '');
          const first = body
            .flatMap((b) => [...nodesOf(b)])
            .find((n) => n['type'] === 'paragraph' && (n['attrs'] as J)['style'] === style);
          return first ? printedText(first, () => '') : '';
        }
        return all.find((x) => x.target === target)?.text ?? '';
      }),
    );
  }
  return pieces;
}

describe.skipIf(!wordAvailable())(
  'EXP-115 criterion 2: numbering labels as Word lays them out',
  () => {
    for (const name of FILES) {
      const file = loadSemantics<File>(name);
      const cases = file.cases.filter((c) => c.valid !== false);
      describe(`[${name} x DOCX]`, () => {
        let made: Promise<Set<string>> | undefined;
        const laidOut = (): Promise<Set<string>> =>
          (made ??= layOutInWord(
            `exp-115-${name}`,
            new Map(cases.map((c) => [c.id, { env: documentOf(file, c) }])),
          ));
        for (const c of cases) {
          it(`[${name} x DOCX] ${c.id}`, async () => {
            const out = await laidOut();
            expect(out.has(c.id), `Word exported ${c.id}`).toBe(true);
            const pieces = piecesOf(c);
            expect(pieces.length).toBeGreaterThan(0);
            const text = dense(pdfTextOf(`exp-115-${name}`, c.id));
            const missing = pieces.filter((p) => !text.includes(dense(p)));
            if (WORD_DIFFERS[`${name}/${c.id}`] !== undefined)
              expect(missing.length, 'a known difference that no longer shows').toBeGreaterThan(0);
            else expect(missing, `not in the PDF text of ${c.id}`).toEqual([]);
          }, 900_000);
        }
      });
    }
  },
);
