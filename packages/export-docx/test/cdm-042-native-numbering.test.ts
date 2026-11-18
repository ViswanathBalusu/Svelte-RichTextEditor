/**
 * CDM-042 criterion 6, DOCX side (owner decision 215, docs/owner-decisions-2026-11-15.md): the DOCX
 * writer writes Word's native numbering, and Word counts the labels itself. This test checks that
 * what the writer writes gives the labels `numbering-lists.json` expects. It writes each case of
 * the fixture, reads `numbering.xml`, `styles.xml` and `document.xml` back and counts the labels
 * with a small model of Word's counting rules (`WordCounter`): counters per abstract numbering, a
 * start override on the first use of a numbering instance, restart after a higher level (or after
 * the level `w:lvlRestart` names), `w:isLgl`, and the number formats. It is a model of Word, not
 * Word: a case where Word itself would differ is listed in `WORD_DIFFERS` with the reason.
 */
import { describe, expect, it } from 'vitest';
import listsFile from '../../model/fixtures/semantics/numbering-lists.json' with { type: 'json' };
import type { JsonEnvelope } from '@docedit/model';
import { AssetStore, entryData, parseXml, readZip, type XmlElement } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';

type J = Record<string, unknown>;
interface Case {
  id: string;
  valid?: boolean;
  settings?: J;
  styles?: J[];
  numberings?: J[];
  stories?: J[];
  body?: J[];
  expected?: { lists?: { id: string; text: string }[] };
}
const file = listsFile as unknown as {
  settings: J;
  styles: J[];
  numberings: J[];
  cases: Case[];
};

/**
 * Cases where the labels of Word's counting, as `WordCounter` models it, differ from the fixture's,
 * with the reason. `at` maps an index into the case's numbered paragraphs, in document order, to
 * the label the writer's output gives. None of these has been checked in Word itself.
 */
const WORD_DIFFERS: Record<string, { why: string; at: Record<number, string> }> = {
  'skipped-level': {
    why: 'A skipped level counts from start - 1 in the model (ADR 0032, shows 0); Word shows the level start.',
    at: { 1: '1.1.1' },
  },
  'skipped-level-with-start': {
    why: 'As skipped-level: the model shows start - 1 (4), Word the start (5).',
    at: { 1: '1.5.1' },
  },
  'template-names-deeper-level': {
    why: 'A template that names a level not yet counted: the model shows start - 1, Word the start.',
    at: { 0: '1-3', 3: '2-3' },
  },
  'headings-numbered-by-style': {
    why: 'As skipped-level, for a heading style that skips a level.',
    at: { 4: '2.1.1' },
  },
  'zero-in-every-format': {
    why: 'Letters and Roman numerals have no zero: the model writes 0, Word writes nothing.',
    at: { 0: '', 2: '' },
  },
  'one-list-two-definitions': {
    why: 'Two definitions cannot share counters in Word (the writer reports it through sharedLists); each counts alone.',
    at: { 1: '1', 2: '2.' },
  },
};
function mergeById(base: readonly J[], extra: readonly J[] = []): J[] {
  const out = [...base];
  for (const n of extra) {
    const id = (n['attrs'] as J | undefined)?.['id'];
    const i = out.findIndex((m) => (m['attrs'] as J | undefined)?.['id'] === id);
    if (i >= 0) out[i] = n;
    else out.push(n);
  }
  return out;
}

function envelopeOf(c: Case): JsonEnvelope {
  const defs = {
    type: 'defs',
    content: [
      { type: 'settings', attrs: { ...file.settings, ...c.settings } },
      ...mergeById(file.styles, c.styles),
      ...mergeById(file.numberings, c.numberings),
      { type: 'page_setup', attrs: { id: 'ps1' } },
    ],
  };
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        defs,
        ...(c.stories ?? []),
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: c.body ?? [] },
      ],
    },
  } as unknown as JsonEnvelope;
}

/** Ids of the body's paragraphs, in document order. */
function paragraphIds(nodes: readonly J[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n['type'] === 'paragraph') out.push(String((n['attrs'] as J)['id']));
    if (Array.isArray(n['content'])) paragraphIds(n['content'] as J[], out);
  }
  return out;
}

const all = (root: XmlElement, local: string): XmlElement[] => {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement): void => {
    if (e.local === local) out.push(e);
    for (const c of e.children) if (c.kind === 'element') walk(c);
  };
  walk(root);
  return out;
};
const child = (e: XmlElement, local: string): XmlElement | undefined =>
  e.children.find((c): c is XmlElement => c.kind === 'element' && c.local === local);
const val = (e: XmlElement | undefined, attr = 'val'): string | undefined =>
  e?.attrs.find((a) => a.local === attr)?.value;

function part(zip: ReturnType<typeof readZip>, name: string): XmlElement {
  const entry = zip.entries.find((e) => e.name === name)!;
  return parseXml(entryData(zip, entry)).root;
}

interface Lvl {
  start: number;
  fmt: string;
  text: string;
  lgl: boolean;
  restart: number | null;
}

const ROMAN: [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

/** One number in one of Word's formats (`aa` after `z`: bijective, as the model counts). */
function formatNumber(n: number, fmt: string): string {
  if (fmt === 'decimal') return String(n);
  if (n < 1) return '';
  if (fmt === 'lowerLetter' || fmt === 'upperLetter') {
    // Word repeats the letter: a, b, ... z, aa, bb, ... zz, aaa.
    const s = String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
    return fmt === 'upperLetter' ? s.toUpperCase() : s;
  }
  if (fmt === 'lowerRoman' || fmt === 'upperRoman') {
    let s = '';
    let k = n;
    for (const [v, r] of ROMAN)
      while (k >= v) {
        s += r;
        k -= v;
      }
    return fmt === 'upperRoman' ? s.toUpperCase() : s;
  }
  return '';
}

/** Word's counting, read from the written parts. */
class WordCounter {
  readonly abstracts = new Map<string, Lvl[]>();
  readonly nums = new Map<string, { abstract: string; overrides: [number, number][] }>();
  readonly counters = new Map<string, (number | undefined)[]>();
  readonly used = new Set<string>();

  constructor(numbering: XmlElement) {
    for (const a of all(numbering, 'abstractNum')) {
      this.abstracts.set(
        val(a, 'abstractNumId')!,
        all(a, 'lvl').map((l) => {
          const restart = val(child(l, 'lvlRestart'));
          return {
            start: Number(val(child(l, 'start')) ?? 1),
            fmt: val(child(l, 'numFmt')) ?? 'decimal',
            text: val(child(l, 'lvlText')) ?? '',
            lgl: child(l, 'isLgl') !== undefined,
            restart: restart === undefined ? null : Number(restart),
          };
        }),
      );
    }
    for (const n of all(numbering, 'num'))
      this.nums.set(val(n, 'numId')!, {
        abstract: val(child(n, 'abstractNumId'))!,
        overrides: all(n, 'lvlOverride').map((o) => [
          Number(val(o, 'ilvl')),
          Number(val(child(o, 'startOverride'))),
        ]),
      });
  }

  next(numId: string, level: number): string {
    const num = this.nums.get(numId)!;
    const levels = this.abstracts.get(num.abstract)!;
    const counter = this.counters.get(num.abstract) ?? [];
    this.counters.set(num.abstract, counter);
    if (!this.used.has(numId)) {
      this.used.add(numId);
      for (const [l, v] of num.overrides) counter[l] = v - 1;
    }
    const lvl = levels[level]!;
    counter[level] = (counter[level] ?? lvl.start - 1) + 1;
    levels.forEach((deeper, k) => {
      if (k <= level) return;
      const after = deeper.restart;
      if (after === null || (after > 0 && level <= after - 1)) counter[k] = undefined;
    });
    if (lvl.fmt === 'bullet') return lvl.text;
    return lvl.text.replace(/%([1-9])/g, (_, d: string) => {
      const k = Number(d) - 1;
      const at = levels[k];
      if (!at) return '';
      const n = counter[k] ?? at.start;
      return formatNumber(n, lvl.lgl && k < level ? 'decimal' : at.fmt);
    });
  }
}

describe('CDM-042 criterion 6: Word counts what the writer writes as the fixture expects', () => {
  const cases = file.cases.filter((c) => c.valid !== false && c.expected?.lists);
  it('covers the cases of numbering-lists.json', () => {
    expect(cases.length).toBeGreaterThan(15);
    for (const id of Object.keys(WORD_DIFFERS)) expect(cases.map((c) => c.id)).toContain(id);
  });
  for (const c of cases) {
    it(c.id, async () => {
      const out = await writeDocx(envelopeOf(c), new AssetStore());
      const zip = readZip(out.bytes);
      const doc = part(zip, 'word/document.xml');
      const styles = part(zip, 'word/styles.xml');
      const counter = new WordCounter(part(zip, 'word/numbering.xml'));

      const styleNum = new Map<string, { numId: string; level: number } | null>();
      const basedOn = new Map<string, string>();
      for (const s of all(styles, 'style')) {
        const id = val(s, 'styleId')!;
        const parent = val(child(s, 'basedOn'));
        if (parent) basedOn.set(id, parent);
        const pPr = child(s, 'pPr');
        const numPr = pPr ? child(pPr, 'numPr') : undefined;
        styleNum.set(
          id,
          numPr
            ? {
                numId: val(child(numPr, 'numId'))!,
                level: Number(val(child(numPr, 'ilvl')) ?? 0),
              }
            : null,
        );
      }
      const viaStyle = (id: string | undefined): { numId: string; level: number } | null => {
        for (let s = id, n = 0; s && n < 20; s = basedOn.get(s), n++) {
          const own = styleNum.get(s);
          if (own) return own;
        }
        return null;
      };

      const labels: string[] = [];
      for (const p of all(doc, 'p')) {
        const pPr = child(p, 'pPr');
        const numPr = pPr ? child(pPr, 'numPr') : undefined;
        const spec = numPr
          ? {
              numId: val(child(numPr, 'numId'))!,
              level: Number(val(child(numPr, 'ilvl')) ?? 0),
            }
          : viaStyle(pPr ? val(child(pPr, 'pStyle')) : undefined);
        if (spec && spec.numId !== '0') labels.push(counter.next(spec.numId, spec.level));
      }

      const expected = c.expected!.lists!;
      const byId = new Map(expected.map((e) => [e.id, e.text]));
      const expectedInOrder = paragraphIds(c.body ?? [])
        .filter((id) => byId.has(id))
        .map((id) => byId.get(id)!);
      const known = WORD_DIFFERS[c.id];
      if (known)
        for (const [i, text] of Object.entries(known.at)) expectedInOrder[Number(i)] = text;
      expect(labels).toEqual(expectedInOrder);
    });
  }
});
