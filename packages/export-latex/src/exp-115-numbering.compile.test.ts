/**
 * EXP-115 criterion 1, numbering labels: the model's shared fixtures `numbering-lists.json`,
 * `numbering-sequences.json`, `numbering-references.json` and `numbering-footnotes.json` run
 * against the LaTeX writer. Each case becomes a document, the converter writes it, the house class
 * compiles it with `lualatex` on this machine, and the labels that the fixture expects are looked
 * for in the text that `pdftotext` extracts from the PDF (not in the converter's TeX).
 *
 * A label is looked for together with the text of its paragraph (`1.` and `Item p01.`), with all
 * white space removed on both sides, because the extractor puts a label and its text on one line
 * with a gap that is not fixed. The pieces are not ordered (a footnote's text is at the foot of
 * the page, after the body).
 *
 * Not checked in the PDF, and said so here: a label of a paragraph in a story that the fixture does
 * not place on a page (a header or footer story is not printed by these documents), the labels of
 * `equation_block` nodes (an equation needs the math gate and an asset; `equations` entries of
 * `numbering-sequences.json`) and a reference that prints nothing (`text: null`).
 *
 * Node.js only. It needs `lualatex` and the local font copy (`test/cdm-local-tex.ts`) and
 * `pdftotext`; it skips without them. Evidence:
 * `pnpm exec vitest run --project node packages/export-latex/src/exp-115-numbering.compile.test.ts`
 * with `DOCEDIT_LUALATEX` and `DOCEDIT_PDFTOTEXT` set when they are not on the PATH.
 */
import { describe, expect, it } from 'vitest';
import { compileLocalAsync, convertLocal, lualatexAvailable } from '../test/cdm-local-tex.ts';
import {
  type DefsFile,
  type DocCase,
  type J,
  documentOf,
  findById,
  loadSemantics,
  nodesOf,
  pdfText,
  pdftotextAvailable,
} from '../test/exp-115-fixtures.ts';

interface Expected {
  lists?: { id: string; text: string; kind?: string }[];
  sequences?: { holder: string; texts: string[] }[];
  equations?: { id: string; text: string }[];
  footnotes?: { id: string; text: string }[];
  references?: { target: string; text: string | null }[];
}
interface Case extends DocCase {
  expected: Expected;
}
interface File extends DefsFile {
  cases: Case[];
}

const ready = lualatexAvailable() && pdftotextAvailable();

const dense = (s: string): string => s.replace(/[\s\u00a0\u2007\u202f]+/g, '');

/** The text a paragraph prints: its text nodes, with `fill` giving the text of each field. */
function printedText(n: J, fill: (field: J) => string): string {
  if (n['type'] === 'text') return String(n['text'] ?? '');
  if (n['type'] === 'footnote') return '';
  if (n['type'] === 'field') return fill(n);
  const content = n['content'];
  return Array.isArray(content) ? content.map((c) => printedText(c as J, fill)).join('') : '';
}

/** The pieces of text that the PDF must contain for one case, and what is not checked. */
function piecesOf(c: Case): { pieces: string[]; unchecked: string[] } {
  const body = (c.body ?? []) as J[];
  const pieces: string[] = [];
  const unchecked: string[] = [];
  const inBody = (id: string): J | undefined => findById(body, id);

  for (const l of c.expected.lists ?? []) {
    const p = inBody(l.id);
    if (!p) {
      unchecked.push(`list ${l.id}: not in the body`);
      continue;
    }
    const text = printedText(p, () => '');
    pieces.push(l.kind === 'none' ? text : `${l.text}${text}`);
  }

  for (const s of c.expected.sequences ?? []) {
    const holder = inBody(s.holder);
    if (!holder) {
      unchecked.push(`sequence ${s.holder}: not in the body`);
      continue;
    }
    let i = 0;
    pieces.push(printedText(holder, () => s.texts[i++] ?? ''));
  }
  for (const e of c.expected.equations ?? [])
    unchecked.push(`equation ${e.id}: needs the math gate`);

  for (const f of c.expected.footnotes ?? []) {
    const fn = inBody(f.id);
    if (!fn) {
      unchecked.push(`footnote ${f.id}: not in the body`);
      continue;
    }
    const note = [...nodesOf(fn)].filter((n) => n['type'] === 'paragraph');
    pieces.push(`${f.text}${note.map((p) => printedText(p, () => '')).join('')}`);
  }

  for (const r of c.expected.references ?? []) {
    // A reference with no label prints nothing: the text around it is still checked.
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
    if (!holder) {
      unchecked.push(`reference ${r.target}: no paragraph holds it`);
      continue;
    }
    const all = c.expected.references ?? [];
    pieces.push(
      printedText(holder, (f) => {
        const target = (f['attrs'] as J)['target'] as string;
        // A style reference prints the text of the first paragraph of that style on the page; the
        // model gives no text for it (the typesetter does), so the fixture's body is read here.
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
  return { pieces, unchecked };
}

/**
 * Cases that fail in the compiled PDF and are kept as known failures (`it.fails`, so the suite
 * turns red when they start to pass). None now: the two cases with a display equation failed until
 * class 0.2.11, because the clip of a display equation left the page's origin displaced by the
 * width of the equation (EXP-052 criterion 5, Notes), so that the paragraph after it was drawn off
 * the page.
 */
const KNOWN_FAILING = new Set<string>([]);

const FILES = [
  'numbering-lists',
  'numbering-sequences',
  'numbering-references',
  'numbering-footnotes',
] as const;

describe.skipIf(!ready)('EXP-115 criterion 1: numbering labels in the extracted PDF text', () => {
  for (const name of FILES) {
    const file = loadSemantics<File>(name);
    describe(`[${name} x LaTeX]`, () => {
      for (const c of file.cases) {
        const known = KNOWN_FAILING.has(`${name}/${c.id}`);
        const test = known ? it.fails : it.concurrent;
        test(`[${name} x LaTeX] ${c.id}${known ? ' (known failure)' : ''}`, async () => {
          const { pieces } = piecesOf(c);
          expect(pieces.length, 'the case has at least one label to check').toBeGreaterThan(0);
          const bundle = await convertLocal(documentOf(file, c), {
            profile: 'preview',
            title: `exp-115-${c.id}`,
            instant: '2026-11-06T10:00:00.000Z',
            timeZone: 'Europe/London',
            suggestions: 'accept',
            layout: 'block',
          } as never);
          const compiled = await compileLocalAsync(bundle, `${name}-${c.id}`);
          if (!compiled.ok)
            throw new Error(`the compile failed (${compiled.dir}):\n${compiled.log.slice(-1500)}`);
          const text = dense(pdfText(compiled.pdf!));
          const missing = pieces.filter((p) => !text.includes(dense(p)));
          expect(missing, `not in the PDF text of ${c.id} (${compiled.dir})`).toEqual([]);
        }, 600_000);
      }
    });
  }
});
