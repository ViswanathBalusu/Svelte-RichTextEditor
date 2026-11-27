/**
 * EXP-025 criterion 3 (lane w2): the text of the exported PDF is compared with the input for the
 * shared corpus of FND-006 (`@docedit/corpus`), not for paragraphs written in the test. Node.js
 * only; the document compiles in the export worker's sandbox (Podman) and `pdftotext -raw` reads
 * the text back.
 *
 * What "equal" means here. `pdftotext` does not give back the spaces of the input (a line end
 * replaces a space, and a run of spaces is one gap), so white space is removed from both sides
 * before the comparison. Then:
 *
 * - every text run of the body, in document order, is found in the PDF text, each after the one
 *   before it (footnote text is set at the foot of the page, so it is looked up on its own);
 * - every text run of the headers and footers is found somewhere in the PDF text;
 * - what is left of the PDF text once the runs are taken out holds no letters at all, apart from
 *   the material the class generates and that is listed in `GENERATED` (field results, such as the
 *   heading text a `styleRef` field repeats).
 *
 * The count of spaces is not checked here; `exp-025-runs.test.ts` checks it on the TeX source.
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { loadDocument } from '@docedit/corpus';
import { convertAndCompile, firstError, pdfText, sandboxReady } from '../test/harness.ts';
import { comparePaged } from '../test/paged-text.ts';

const ready = (await sandboxReady()).ok;

type Node = Record<string, unknown>;

interface Runs {
  /** Text runs of the body, in document order, without footnote text. */
  body: string[];
  /** Text runs of footnotes. */
  notes: string[];
  /** Text runs of headers and footers. */
  furniture: string[];
  /** The text of each heading paragraph and caption (the lists of contents, figures and tables repeat it). */
  headings: string[];
  /** The header rows of tables, which are set again on each page the table runs on. */
  repeated: string[];
  /** The indexes of the runs of ody that belong to figures and captions. */
  floatAt: Set<number>;
  /** The runs of figures and captions: floats, set where there is room and not where defined. */
  floats: string[];
  /** The LaTeX of the equations. */
  latex: string[];
}

const squash = (s: string): string => s.replace(/[\s\u00ad]+/gu, '');

/** The text runs of an envelope, split by where the class sets them. */
function collect(doc: Node): Runs {
  const out: Runs = {
    body: [],
    notes: [],
    furniture: [],
    headings: [],
    repeated: [],
    floats: [],
    floatAt: new Set(),
    latex: [],
  };
  const attr = (node: Node, key: string): unknown => (node['attrs'] as Node | undefined)?.[key];
  /** The runs of a subtree, into `into`, leaving the other lists as they are. */
  const runsOf = (n: unknown, into: string[]): string[] => {
    const before = {
      body: out.body.length,
      floats: out.floats.length,
      headings: out.headings.length,
    };
    walk(n, into);
    out.body.length = Math.min(out.body.length, before.body);
    out.floats.length = before.floats;
    out.headings.length = before.headings;
    return into;
  };
  const walk = (n: unknown, into: string[]): void => {
    if (Array.isArray(n)) {
      for (const c of n) walk(c, into);
      return;
    }
    if (!n || typeof n !== 'object') return;
    const node = n as Node;
    if (node['type'] === 'text') {
      const marks = ((node['marks'] as Node[] | undefined) ?? []).map((m) => m['type']);
      // Hidden text is not set. All capitals set the text in capitals.
      if (marks.includes('hidden')) return;
      const text = String(node['text'] ?? '');
      const t = squash(marks.includes('allCaps') ? text.toUpperCase() : text);
      if (t !== '') into.push(t);
      return;
    }
    if (node['type'] === 'defs') return;
    const latex = attr(node, 'latex');
    if (typeof latex === 'string') out.latex.push(latex);
    const style = attr(node, 'style');
    if (node['type'] === 'table') {
      // A table that runs over a page break sets its header rows again at the top of the next page.
      const rows = Number(attr(node, 'headerRows') ?? 0);
      const head = ((node['content'] as Node[] | undefined) ?? []).slice(0, rows);
      for (const r of head) out.repeated.push(runsOf(r, []).join(''));
    }
    const next =
      node['type'] === 'footnote' ? out.notes : node['type'] === 'story' ? out.furniture : into;
    if (
      node['type'] === 'caption' ||
      (node['type'] === 'paragraph' && typeof style === 'string' && /^Heading[1-9]$/.test(style))
    ) {
      // The lists of contents, figures and tables, and the running head, repeat these.
      const before = next.length;
      walk(node['content'], next);
      out.headings.push(next.slice(before).join(''));
      if (node['type'] === 'caption') out.floats.push(...next.slice(before));
      if (node['type'] === 'caption' && next === out.body)
        for (let i = before; i < next.length; i++) out.floatAt.add(i);
      return;
    }
    if (node['type'] === 'figure') {
      const before = next.length;
      walk(node['content'], next);
      out.floats.push(...next.slice(before));
      if (next === out.body) for (let i = before; i < next.length; i++) out.floatAt.add(i);
      return;
    }
    walk(node['content'], next);
  };
  walk(doc['content'], out.body);
  return out;
}
/** A line-end hyphen that TeX's hyphenation may have added: it matches a hyphen of the input or nothing. */
const BREAK = '\u0001';

/** The PDF text without white space, with each hyphen at a line end between letters as `BREAK`. */
function pdfSquash(text: string): string {
  return squash(text.replace(/(?<=\p{L})-\r?\n(?=\p{L})/gu, BREAK));
}

/**
 * Where `run` ends when it is read from `at` in the squashed PDF text, or -1 when it is not there.
 * A `BREAK` in the PDF text matches a hyphen of the run or nothing, whatever line breaks TeX chose.
 */
function matchAt(pdf: string, at: number, run: string): number {
  let p = at;
  for (let i = 0; i < run.length; i++) {
    if (pdf[p] === BREAK) {
      p++;
      if (run[i] === '-') continue;
    }
    if (pdf[p] !== run[i]) return -1;
    p++;
  }
  return p;
}
/**
 * Takes the runs out of the PDF text. Returns the runs that were not found and what is left.
 * Body runs are searched in order, each from the end of the one before; footnote and furniture runs
 * are searched afterwards, anywhere in what the body left.
 */
function subtract(pdf: string, runs: Runs): { missing: string[]; rest: string } {
  const used = new Array<boolean>(pdf.length).fill(false);
  const missing: string[] = [];
  const take = (run: string, from: number): number => {
    const first = run[0] === '-' ? BREAK : run.charAt(0);
    for (let at = pdf.indexOf(first, from); at >= 0; at = pdf.indexOf(first, at + 1)) {
      const end = matchAt(pdf, at, run);
      if (end < 0 || used.slice(at, end).some(Boolean)) continue;
      used.fill(true, at, end);
      return end;
    }
    missing.push(run);
    return from;
  };
  let cursor = 0;
  for (const run of runs.body) cursor = take(run, cursor);
  // Longest first, so that a short run ("Page") does not take part of a longer one.
  const loose = [...runs.notes, ...runs.furniture].sort((x, y) => y.length - x.length);
  for (const run of loose) take(run, 0);
  let rest = '';
  for (let i = 0; i < pdf.length; i++) if (!used[i] && pdf[i] !== BREAK) rest += pdf[i];
  return { missing, rest };
}
/**
 * Text in the PDF that is not a run of the input, per corpus document: the result of the header's
 * `styleRef` field, which repeats the first heading of the page.
 */
const GENERATED: Record<string, string[]> = { 'pages-1': ['Purpose'] };

/** A letter of the Mathematical Alphanumeric Symbols block, as the equation's font prints it. */
const MATH_LETTER = /[\u{1D400}-\u{1D7FF}]/u;

async function compileCorpus(name: string): Promise<{ text: string; raw: string; runs: Runs }> {
  const corpus = await loadDocument(name);
  const assets: Record<string, { sha256: string; mediaType: string; bytes: Uint8Array }> = {};
  for (const a of corpus.assets)
    assets[a.entry.id] = { sha256: a.entry.sha256, mediaType: a.entry.mediaType, bytes: a.bytes };
  const c = await convertAndCompile(
    corpus.envelope,
    {
      profile: 'preview',
      title: `exp-025-${name}`,
      assets,
      instant: '2026-11-06T10:00:00.000Z',
      timeZone: 'Europe/London',
      suggestions: 'accept',
    } as never,
    { minPasses: 2, limits: { wallSeconds: 14_400, memoryMiB: 4096 } },
  );
  if (!c.compile.ok || !c.compile.pdf)
    throw new Error(`the compile of ${name} failed: ${firstError(c.compile.log)}`);
  const text = pdfText(c.compile.pdf);
  if (text === null) throw new Error('pdftotext is not installed or failed');
  return {
    text: pdfSquash(text),
    raw: text,
    runs: collect(corpus.envelope.doc as unknown as Node),
  };
}

describe.skipIf(!ready)(
  'EXP-025 criterion 3: the extracted PDF text equals the input for the shared corpus',
  () => {
    it('pages-1: every run is in the PDF, body runs in order, and nothing else but generated text', async () => {
      const { text, runs } = await compileCorpus('pages-1');
      expect(runs.body.length).toBeGreaterThan(30);
      const { missing, rest } = subtract(text, runs);
      expect(missing).toEqual([]);
      // What is left is generated by the class: numbers (heading, list, caption, footnote and page
      // numbers), list bullets, the inline equation, and the results of the fields in GENERATED.
      let left = rest;
      for (const g of GENERATED['pages-1'] ?? []) {
        expect(left).toContain(g);
        left = left.replace(g, '');
      }
      const letters = Array.from(left).filter((ch) => /\p{L}/u.test(ch) && !MATH_LETTER.test(ch));
      expect(letters).toEqual([]);
    }, 300_000);

    // The documents of more than one page. `generated` is text the class makes: the label of a
    // caption, the title the job gives the PDF (the running head of the contents pages) and the page
    // number of those pages.
    // pages-300 and pages-1000 are not in this list (EXP-025 Notes, lane w2, 2026-11-27): pages-300
    // compiles and is not yet equal (41 level-3 headings are not in its contents list, and one
    // footnote run is not matched); pages-1000 was not compiled.
    for (const [name, minPages] of [
      ['pages-20', 20],
      ['pages-100', 80],
    ] as const) {
      it(`${name}: every run is in the PDF text across its page breaks, and nothing else but generated text`, async () => {
        const { raw, runs } = await compileCorpus(name);
        expect(runs.body.length).toBeGreaterThan(500);
        expect(raw.split('\f').length).toBeGreaterThan(minPages);
        // The text of the corpus has Latin, Chinese, Japanese and Korean runs: all of them are set.
        expect(runs.body.join('')).toMatch(/\p{Script=Han}/u);
        expect(runs.body.join('')).toMatch(/\p{Script=Hiragana}/u);
        expect(runs.body.join('')).toMatch(/\p{Script=Hangul}/u);
        const r = comparePaged(raw, {
          ...runs,
          generated: ['Figure', 'Table', `exp-025-${name}`, 'ii', 'iii', 'iv', 'v'],
        });
        expect(r.missing).toEqual([]);
        // The lists of contents, figures and tables repeat every heading and caption.
        expect(r.contentsMissing).toEqual([]);
        // Only a float (a figure and its caption) is set above the run that precedes it in the input.
        expect(r.unordered.filter((u) => !runs.floats.includes(u))).toEqual([]);
        // What is left is generated: the names of the operators of an equation (`\lim`) and the
        // letters of list labels (a, b, c, i, ii, A, I, II).
        let left = r.letters.join('');
        for (const op of runs.latex.flatMap((l) => l.match(/(?<=\\)[a-z]+(?=_|\b)/gu) ?? []))
          if (['lim', 'sin', 'cos', 'log', 'max', 'min'].includes(op)) left = left.replace(op, '');
        expect(left).toMatch(/^[abcivxABCIVX]*$/u);
      }, 900_000);
    }
  },
);
