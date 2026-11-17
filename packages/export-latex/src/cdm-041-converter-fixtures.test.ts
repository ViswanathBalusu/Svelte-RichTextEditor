/**
 * CDM-041 criterion 7, LaTeX side, on the converter's own output (Node.js): every case of
 * `packages/model/fixtures/semantics/cascade.json` is converted, and the setters that reach
 * `main.tex` and `styles.tex` are read back and compared with the fixture's values.
 *
 * A paragraph writes its style macro and then the properties that differ, so the value in force is
 * the last setter of a name in "macro body, then the paragraph's own setters". A run that differs
 * from its paragraph writes `\DEfont` and wrappers (`\DEc`, `\DEul`, `\DEst`, `\DEsup`, `\DEhl`,
 * `\DEuc`); a list label is written the same way.
 *
 * The setters do not carry every property. Those they do not carry are listed in `NOT_IN_SETTERS`;
 * the test fails when a fixture expects a property that is neither compared nor listed there.
 * Spacing before and after, contextual spacing, keep with next and page break before are applied by
 * `blocks.ts` as gaps and penalties between blocks (CDM-043 runs those); borders are not drawn yet
 * (EXP-020) and right-to-left is not set (EXP-037).
 */
import { describe, expect, it } from 'vitest';
import { twipsToBp } from '@docedit/model';
import cascadeFile from '../../model/fixtures/semantics/cascade.json' with { type: 'json' };
import { blockLines, doc, FONTS, run, type J } from '../test/docs.ts';

interface CascadeCase {
  id: string;
  description: string;
  settings?: J;
  styles?: J[];
  numberings?: J[];
  paragraph: J;
  context?: { tableStyle?: string };
  marks?: J[];
  expected: { error?: string; paragraph?: J; run?: J; labelRun?: J };
}

interface CascadeFile {
  settings: J;
  styles: J[];
  numberings: J[];
  cases: CascadeCase[];
}

const file = cascadeFile as unknown as CascadeFile;
const PARAGRAPH_ID = 'p00xxxxxxxxxxxxx';

const NOT_IN_SETTERS = new Set([
  'paragraph.spaceBefore',
  'paragraph.spaceAfter',
  'paragraph.contextualSpacing',
  'paragraph.keepNext',
  'paragraph.pageBreakBefore',
  'paragraph.borders',
  'paragraph.dir',
  'run.lang',
]);

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

function envelopeOf(c: CascadeCase) {
  const paragraph = {
    type: 'paragraph',
    attrs: { id: PARAGRAPH_ID, ...c.paragraph },
    content: [{ type: 'text', text: 'Text', ...(c.marks ? { marks: c.marks } : {}) }],
  };
  const tableStyle = c.context?.tableStyle;
  const block = tableStyle
    ? {
        type: 'table',
        attrs: { id: 'tablexxxxxxxxxxx', style: tableStyle, grid: [9000] },
        content: [
          {
            type: 'table_row',
            attrs: { id: 'rowxxxxxxxxxxxxx' },
            content: [
              { type: 'table_cell', attrs: { id: 'cellxxxxxxxxxxxx' }, content: [paragraph] },
            ],
          },
        ],
      }
    : paragraph;
  return doc([block], {
    settings: { ...file.settings, ...c.settings },
    styles: mergeById(file.styles, c.styles),
    numberings: mergeById(file.numberings, c.numberings),
  });
}

/** The braced groups that follow position `at`, as their contents. */
function groups(s: string, at: number): { args: string[]; end: number } {
  const args: string[] = [];
  let i = at;
  while (s[i] === '{') {
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) break;
    }
    args.push(s.slice(i + 1, j));
    i = j + 1;
  }
  return { args, end: i };
}

/** The setters of a string, later ones replacing earlier ones of the same name. */
function settersOf(s: string, into = new Map<string, string[]>()): Map<string, string[]> {
  const re = /\\(DE[A-Za-z]+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const g = groups(s, m.index + m[0].length);
    into.set(m[1]!, g.args);
    re.lastIndex = g.end;
  }
  return into;
}

interface Written {
  /** The paragraph's setters in force: its style macro, then its own. */
  readonly paragraph: Map<string, string[]>;
  /** The paragraph's content argument: its runs. */
  readonly content: string;
  /** The label argument of a list item, or null. */
  readonly label: string | null;
  readonly styles: string;
}

async function written(c: CascadeCase): Promise<Written> {
  const b = await run(envelopeOf(c));
  const styles = b.files['styles.tex']!;
  const text = blockLines(b, PARAGRAPH_ID).join('\n');
  const head = /\\(DEp|DEcp|DEli|DEh)\{/.exec(text);
  if (!head) throw new Error(`no paragraph is written for ${c.id}:\n${text}`);
  const g = groups(text, head.index + head[0].length - 1);
  // A heading writes its outline level before its setters.
  const own = g.args[head[1] === 'DEh' ? 2 : 1] ?? '';
  const macro = /\\(DES[a-z]+)/.exec(own)?.[1];
  const paragraph = new Map<string, string[]>();
  if (macro) {
    const def = styles.split('\n').find((l) => l.startsWith(`\\def\\${macro}{`));
    if (!def) throw new Error(`no definition of ${macro}`);
    settersOf(def.slice(`\\def\\${macro}{`.length, -1), paragraph);
  }
  settersOf(own.replace(/\\DES[a-z]+/, ''), paragraph);
  return {
    paragraph,
    content: g.args[g.args.length - 1] ?? '',
    label: head[1] === 'DEli' ? (g.args[2] ?? '') : null,
    styles,
  };
}

const ALIGN_CODE: Record<string, string> = {
  justify: '0',
  distribute: '0',
  start: '1',
  center: '2',
  end: '3',
};
const TAB_ALIGN: Record<string, string> = { left: 'l', center: 'c', right: 'r', decimal: 'd' };
const TAB_LEADER: Record<string, string> = {
  none: 'n',
  dot: 'd',
  hyphen: 'h',
  underscore: 'u',
  middleDot: 'm',
  heavy: 't',
};
const hex = (colour: unknown): string => String(colour).replace('#', '').toUpperCase();
const flag = (v: unknown): string => (v ? '1' : '0');

/** The family number the converter writes for a family name: the manifest's, else the default (1). */
function familyNumber(name: unknown): string {
  const i = FONTS.families.findIndex((f) => f.name === name);
  return String(i < 0 ? 1 : i + 1);
}

function checkParagraph(w: Written, expected: J, key: string): boolean {
  const v = expected[key];
  const s = (name: string): string | undefined => w.paragraph.get(name)?.[0];
  switch (key) {
    case 'align':
      expect(s('DEal'), key).toBe(ALIGN_CODE[v as string]);
      return true;
    case 'indentLeft':
      expect(s('DEil'), key).toBe(twipsToBp(v as number));
      return true;
    case 'indentRight':
      expect(s('DEir'), key).toBe(twipsToBp(v as number));
      return true;
    case 'indentFirstLine':
      expect(s('DEif'), key).toBe(twipsToBp(v as number));
      return true;
    case 'widowControl':
      expect(s('DEwc'), key).toBe(flag(v));
      return true;
    case 'keepLines':
      expect(s('DEkl'), key).toBe(flag(v));
      return true;
    case 'lineRule': {
      const name = v === 'exact' ? 'DElse' : v === 'atLeast' ? 'DElsa' : 'DElsm';
      // The rule in force is the last line setter written.
      const last = [...w.paragraph.keys()].filter((k) => /^DEls[mea]$/.test(k)).pop();
      expect(last, key).toBe(name);
      return true;
    }
    case 'lineSpacing': {
      const last = [...w.paragraph.keys()].filter((k) => /^DEls[mea]$/.test(k)).pop();
      expect(last && w.paragraph.get(last)?.[0], key).toBe(String(v));
      return true;
    }
    case 'tabs': {
      const k = s('DEtabs');
      const tabs = v as { position: number; align: string; leader: string }[];
      if (tabs.length === 0) expect(k, key).toBe('0');
      else {
        const def = w.styles.split('\n').find((l) => l.startsWith(`\\DEdeftabs{${k}}{`));
        expect(def, key).toBe(
          `\\DEdeftabs{${k}}{${tabs
            .map((t) => `${t.position}:${TAB_ALIGN[t.align]}:${TAB_LEADER[t.leader]}`)
            .join(';')}}`,
        );
      }
      return true;
    }
    case 'shading': {
      const fill = (v as { fill?: string } | null)?.fill;
      if (fill) expect(s('DEshade'), key).toBe(hex(fill));
      else expect(w.paragraph.has('DEshade'), key).toBe(false);
      return true;
    }
    default:
      return false;
  }
}

/**
 * Compares one expected run property with what is written around a run or a label: `\DEfont` and
 * the wrappers when present, else the paragraph's setters, which the run then takes unchanged.
 */
function checkRun(w: Written, text: string, expected: J, key: string): boolean {
  const v = expected[key];
  const fontAt = text.indexOf('\\DEfont{');
  const font = fontAt < 0 ? null : groups(text, fontAt + '\\DEfont'.length).args;
  const s = (name: string): string | undefined => w.paragraph.get(name)?.[0];
  const weight = font ? font[2] === 'b' : s('DEbf') === '1';
  const shape = font ? font[3]! : null;
  switch (key) {
    case 'fontFamily':
      expect(font ? font[0] : s('DEfam'), key).toBe(familyNumber(v));
      return true;
    case 'fontSize':
      expect(font ? font[1] : s('DEsz'), key).toBe(twipsToBp(v as number));
      return true;
    case 'bold':
      expect(weight, key).toBe(v);
      return true;
    case 'italic':
      expect(shape !== null ? shape === 'it' || shape === 'scit' : s('DEit') === '1', key).toBe(v);
      return true;
    case 'smallCaps':
      expect(shape !== null ? shape === 'sc' || shape === 'scit' : s('DEsc') === '1', key).toBe(v);
      return true;
    case 'color': {
      const wrapped = /\\DEc\{([0-9A-Fa-f]{6})\}/.exec(text)?.[1];
      // The last of \DEcol and \DEnocol is in force when the run writes no colour of its own.
      const names = [...w.paragraph.keys()].filter((k) => k === 'DEcol' || k === 'DEnocol');
      const paragraphColour = names.pop() === 'DEcol' ? s('DEcol') : null;
      expect(wrapped ?? paragraphColour ?? null, key).toBe(v === null ? null : hex(v));
      return true;
    }
    case 'underline':
      expect(
        /\\DEuld\{/.test(text)
          ? 'double'
          : /\\DEulo\{/.test(text)
            ? 'dotted'
            : /\\DEul\{/.test(text)
              ? 'single'
              : 'none',
        key,
      ).toBe(v);
      return true;
    case 'strike':
      expect(/\\DEst\{/.test(text), key).toBe(v);
      return true;
    case 'allCaps':
      expect(/\\DEuc\{/.test(text), key).toBe(v);
      return true;
    case 'vertAlign':
      expect(
        /\\DEsup\{/.test(text) ? 'super' : /\\DEsub\{/.test(text) ? 'sub' : 'baseline',
        key,
      ).toBe(v);
      return true;
    case 'highlight':
      expect(/\\DEhl\{DEhl([A-Za-z]+)\}/.exec(text)?.[1] ?? null, key).toBe(v);
      return true;
    default:
      return false;
  }
}

describe('cascade fixtures through the LaTeX converter output (CDM-041 criterion 7)', () => {
  const uncompared = new Set<string>();

  for (const c of file.cases)
    it(`${c.id}: ${c.description}`, async () => {
      if (c.expected.error) {
        // A typed error is reported and the paragraph is still written.
        const b = await run(envelopeOf(c));
        expect(b.diagnostics.map((d) => d.code)).toContain(c.expected.error);
        expect(blockLines(b, PARAGRAPH_ID).join('\n')).toContain('{Text}');
        return;
      }
      const w = await written(c);
      for (const key of Object.keys(c.expected.paragraph ?? {}))
        if (!checkParagraph(w, c.expected.paragraph ?? {}, key)) uncompared.add(`paragraph.${key}`);

      const expectedRun = c.expected.run ?? {};
      if (expectedRun['hidden'] === true) {
        expect(w.content).not.toContain('{Text}');
      } else {
        for (const key of Object.keys(expectedRun)) {
          if (key === 'hidden') {
            expect(w.content).toContain('{Text}');
            continue;
          }
          if (!checkRun(w, w.content, expectedRun, key)) uncompared.add(`run.${key}`);
        }
      }

      const labelRun = c.expected.labelRun ?? {};
      if (Object.keys(labelRun).length > 0) {
        if (w.label === null) throw new Error('the paragraph is not written as a list item');
        for (const key of Object.keys(labelRun))
          if (!checkRun(w, w.label, labelRun, key)) uncompared.add(`labelRun.${key}`);
      }
    });

  it('compares every expected property the setters carry', () => {
    expect([...uncompared].filter((k) => !NOT_IN_SETTERS.has(k))).toEqual([]);
  });
});
