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
import { computeLabels } from '@docedit/model';
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
 * Cases whose labels differ in Word from the fixture, with the reason. None now: owner decision 238
 * (2026-11-26) made Word's labels the rule where they disagreed with the model, and the model, its
 * fixtures and the writer were changed to match (ADR 0032; `packages/model/src/numbering/labels.ts`).
 * A case that starts to differ is added here with its reason, and the run asserts that it still
 * differs, so that the list cannot go stale.
 */
const WORD_DIFFERS: Readonly<Record<string, string>> = {};
/** The footnote of the body that holds the paragraph `id`, if any. */
function footnoteHolding(body: readonly J[], id: string): J | undefined {
  for (const b of body)
    for (const n of nodesOf(b)) if (n['type'] === 'footnote' && findById([n], id)) return n;
  return undefined;
}

function piecesOf(file: File, c: Case): string[] {
  const body = (c.body ?? []) as J[];
  const pieces: string[] = [];
  const marks = computeLabels(documentOf(file, c).doc as never).footnotes;
  for (const l of c.expected.lists ?? []) {
    const p = findById(body, l.id);
    if (!p) continue;
    const text = printedText(p, () => '');
    // In a footnote, Word prints the footnote's mark between the list label and the text.
    const note = footnoteHolding(body, l.id);
    const mark = note ? (marks.get(String((note['attrs'] as J)['id'])) ?? '') : '';
    pieces.push(l.kind === 'none' ? text : `${l.text}${mark}${text}`);
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
            const pieces = piecesOf(file, c);
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
