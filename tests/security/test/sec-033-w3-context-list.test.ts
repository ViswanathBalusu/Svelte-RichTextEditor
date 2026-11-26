/**
 * SEC-033 criterion 2 (10 §3.4; 09 §4, §14): every context in which a user string can reach TeX is
 * listed, and each has a test with hostile values.
 *
 * The list is CONTEXTS below: the ten contexts the criterion names, each with the CDM attributes
 * or converter options that carry it, the emitter it goes through, and the test that feeds it
 * hostile values. The first test checks the list against the code: each attribute is in the
 * converter's own table of attributes and emitters (`ATTRIBUTE_EMITTERS`, which
 * `attributes.test.ts` keeps complete against the CDM) with the emitter named here, and each named
 * test exists under the title named here.
 *
 * Numbering templates had no test: the rest of this file is that test. A numbering level's `text`
 * is a template (`%1.`), and the label made from it goes through `text`. Hostile templates are
 * converted by the real converter, and the list item's line must hold only the escapes `text`
 * writes and the class's own macros. Node.js only; nothing compiles here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_EMITTERS } from '../../../packages/export-latex/src/attributes.ts';
import { blockLines, doc, para, run, type J } from '../../../packages/export-latex/test/docs.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUNS = Number(process.env['FUZZ_RUNS'] ?? 60);

interface Context {
  name: string;
  /** Attributes of the CDM that carry it, as named in `ATTRIBUTE_EMITTERS`. */
  attributes: string[];
  /** Other ways in: a mark or a converter option, which the attribute table does not hold. */
  other?: string;
  emitter: string;
  tests: { file: string; title: string }[];
}

const CONTEXTS_TEST = 'tests/security/test/sec-033-contexts.test.ts';
const COMPILED_TEXT = 'packages/export-latex/src/sec-033-hostile-text.compile.test.ts';

const CONTEXTS: Context[] = [
  {
    name: 'body text',
    attributes: ['form_field.value', 'field.cached', 'page_setup.watermark'],
    other: 'text nodes',
    emitter: 'text',
    tests: [
      { file: CONTEXTS_TEST, title: 'SEC-033 criterion 2: body text (text) with hostile values' },
      {
        file: COMPILED_TEXT,
        title: 'SEC-033 criterion 1: hostile body text comes out of the PDF as typed',
      },
    ],
  },
  {
    name: 'alternative text',
    attributes: ['figure.alt', 'image.alt'],
    emitter: 'kvValue',
    tests: [
      {
        file: CONTEXTS_TEST,
        title:
          'SEC-033 criterion 2: alternative text, field labels and PDF metadata (kvValue, pdfString)',
      },
    ],
  },
  {
    name: 'PDF metadata',
    attributes: ['hidden_region.title', 'mark:link.title'],
    other: 'the title option of the converter',
    emitter: 'pdfString',
    tests: [
      {
        file: CONTEXTS_TEST,
        title:
          'SEC-033 criterion 2: alternative text, field labels and PDF metadata (kvValue, pdfString)',
      },
    ],
  },
  {
    name: 'URLs',
    // The URL and DOI of a source no longer reach the .tex file: since EXP-121 they go to
    // references.bib through `bibField` (exp-121-biblatex.test.ts holds their hostile cases).
    attributes: ['mark:link.href'],
    emitter: 'url',
    tests: [{ file: CONTEXTS_TEST, title: 'SEC-033 criterion 2: link targets (url)' }],
  },
  {
    name: 'numbering templates',
    attributes: ['numbering_def.levels', 'paragraph.numbering'],
    emitter: 'text',
    tests: [
      {
        file: 'tests/security/test/sec-033-w3-context-list.test.ts',
        title: 'SEC-033 criterion 2: numbering templates with hostile values',
      },
    ],
  },
  {
    name: 'bullet characters',
    // The same attribute as the templates: a bullet level's character is looked up in a table.
    attributes: ['numbering_def.levels'],
    other: 'bulletChar of a level, through the table of published bullets',
    emitter: 'text',
    tests: [
      {
        file: 'tests/security/test/sec-033-v-bullets.test.ts',
        title: 'SEC-033 criterion 2: bullet characters with hostile values',
      },
    ],
  },
  {
    name: 'labels',
    attributes: ['form_field.label'],
    emitter: 'kvValue',
    tests: [
      {
        file: CONTEXTS_TEST,
        title:
          'SEC-033 criterion 2: alternative text, field labels and PDF metadata (kvValue, pdfString)',
      },
    ],
  },
  {
    name: 'colours',
    attributes: [
      'style_def.color',
      'style_def.shading',
      'style_def.headerRowShading',
      'paragraph.shading',
      'table_cell.shading',
      'mark:color.value',
    ],
    emitter: 'color',
    tests: [
      { file: CONTEXTS_TEST, title: 'SEC-033 criterion 2: colours (color) and lengths (dimen)' },
    ],
  },
  {
    name: 'lengths',
    attributes: ['style_def.fontSize', 'mark:fontSize.value'],
    emitter: 'dimen',
    tests: [
      { file: CONTEXTS_TEST, title: 'SEC-033 criterion 2: colours (color) and lengths (dimen)' },
    ],
  },
  {
    name: 'language names',
    attributes: ['settings.lang', 'mark:lang.value'],
    emitter: 'enumLookup',
    tests: [
      {
        file: CONTEXTS_TEST,
        title: 'SEC-033 criterion 3 (converter half): each supported language',
      },
      {
        file: COMPILED_TEXT,
        title: 'SEC-033 criterion 3: the text oracle holds in every language',
      },
    ],
  },
];

describe('SEC-033 criterion 2: the list of contexts', () => {
  it('names the ten contexts of the criterion', () => {
    expect(CONTEXTS.map((c) => c.name)).toEqual([
      'body text',
      'alternative text',
      'PDF metadata',
      'URLs',
      'numbering templates',
      'bullet characters',
      'labels',
      'colours',
      'lengths',
      'language names',
    ]);
  });

  it('agrees with the converter table of attributes and emitters', () => {
    for (const c of CONTEXTS)
      for (const a of c.attributes)
        expect(ATTRIBUTE_EMITTERS[a], `${c.name}: ${a}`).toBe(c.emitter);
    // Every colour attribute of the CDM is in the colours context: the table has no other.
    const colours = Object.entries(ATTRIBUTE_EMITTERS)
      .filter(([, e]) => e === 'color')
      .map(([a]) => a)
      .sort();
    expect(colours).toEqual([...CONTEXTS.find((c) => c.name === 'colours')!.attributes].sort());
  });

  it('names an existing test with hostile values for each context', () => {
    for (const c of CONTEXTS) {
      expect(c.tests.length, c.name).toBeGreaterThan(0);
      for (const t of c.tests) {
        expect(existsSync(ROOT + t.file), `${c.name}: ${t.file}`).toBe(true);
        expect(readFileSync(ROOT + t.file, 'utf8'), `${c.name}: ${t.title}`).toContain(t.title);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Numbering templates

const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;

/** A numbered paragraph whose level has `template` as its text. */
function numbered(template: string): { p: J; d: ReturnType<typeof doc> } {
  const p = para('item', { numbering: { numberingId: 'num', level: 0, listId: 'L' } });
  const d = doc([p], {
    numberings: [
      {
        type: 'numbering_def',
        attrs: { id: 'num', levels: [{ format: 'decimal', text: template, start: 1 }] },
      },
    ],
  });
  return { p, d };
}

/** The seeds of criterion 1, as templates; most keep the `%1` a real template has. */
const SEEDS = [
  '%1.\\write18{rm -rf /}',
  '%1\\directlua{os.execute("id")}',
  '\\input{/etc/passwd}%1',
  '^^5cwrite18 %1',
  '%1}\\def\\x{',
  '%comment\n\\section{x}',
  '%1\n[bracket after a line break',
  '\u202eevil\u202c %1',
  '%1\u0000\u0007\u007f\u009b',
  '\\\\ \\& \\$ \\# \\_ \\% \\^ \\~',
  '%1 $$ \\DEstr{41} ) ] ]]',
  `%1 ${'a'.repeat(2000)}`,
];

const hostile = fc.oneof(
  fc.constantFrom(...SEEDS),
  fc.string({ maxLength: 40 }).map((s) => `%1${s}`),
  fc
    .array(fc.constantFrom('\\', '{', '}', '%', '#', '&', '$', '^', '~', '[', ']', '_', ' ', '1'), {
      maxLength: 40,
    })
    .map((cs) => cs.join('')),
);

/** The escapes `text` writes; anything else with a backslash is not that emitter's output. */
const TEXT_ESCAPE = /\\(?:textbackslash\{\}|textasciicircum\{\}|textasciitilde\{\}|[{}$&#_%\- ])/g;

/** The list item's line: after the escapes of `text`, only the class's own macros are left. */
function expectOnlyClassMacros(line: string): void {
  const stripped = line.replace(TEXT_ESCAPE, '');
  for (const word of stripped.match(/\\[A-Za-z@]+|\\./g) ?? [])
    expect(word, line.slice(0, 300)).toMatch(/^\\(?:DE[A-Za-z]+|begin|end)$/);
  // `\begin` and `\end` only open and close the class's own environments.
  expect(stripped).not.toMatch(/\\(?:begin|end)(?!\{DE[A-Za-z]+\})/);
  expect(stripped).not.toMatch(/\^\^/);
  // No control character and no bidirectional control is left in the line.
  const removed = [...stripped].filter((ch) => {
    const c = ch.codePointAt(0)!;
    return (
      c <= 0x1f ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    );
  });
  expect(removed).toEqual([]);
}

async function itemLines(template: string): Promise<string[]> {
  const { p, d } = numbered(template);
  const bundle = await run(d);
  const lines = blockLines(bundle, idOf(p));
  expect(lines.some((l) => l.includes('\\DEli{'))).toBe(true);
  return lines;
}

describe('SEC-033 criterion 2: numbering templates with hostile values', () => {
  it('writes an ordinary template as the label of the list item', async () => {
    const lines = await itemLines('Clause %1.');
    expect(lines.join('\n')).toContain('Clause 1.');
  });

  it('writes each seed through the text emitter: escapes and class macros only', async () => {
    for (const seed of SEEDS) {
      const lines = await itemLines(seed);
      for (const line of lines) expectOnlyClassMacros(line);
      const all = lines.join('\n');
      expect(all).not.toMatch(/\\(?:write18|directlua|input|def|section)\b/);
    }
    // The seed is still there as text: its backslash is the escape, not a control sequence.
    const kept = (await itemLines('%1.\\write18{rm -rf /}')).join('\n');
    expect(kept).toContain('\\textbackslash{}write18\\{rm -rf /\\}');
  });

  it('holds for random and mutated templates', async () => {
    await fc.assert(
      fc.asyncProperty(hostile, async (template) => {
        for (const line of await itemLines(template)) expectOnlyClassMacros(line);
      }),
      { numRuns: RUNS },
    );
  }, 120_000);
});
