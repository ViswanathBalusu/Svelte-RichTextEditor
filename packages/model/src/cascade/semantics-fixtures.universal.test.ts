// The shared layout-semantics fixtures (CDM-005; CDM-041 to CDM-045; ADR 0032), run against the
// model's one implementation in Node.js and in Chromium, Firefox and WebKit. Every file in
// fixtures/semantics is imported here; `semantics-fixtures-list.test.ts` fails when one is not.
// Each fixture document is also validated, so the inputs are real CDM documents that the layout
// engine and the writers can run through their own pipelines.
import { describe, expect, it } from 'vitest';
import cascadeFile from '../../fixtures/semantics/cascade.json' with { type: 'json' };
import dateFile from '../../fixtures/semantics/date-fields.json' with { type: 'json' };
import headerFile from '../../fixtures/semantics/header-growth.json' with { type: 'json' };
import lineFile from '../../fixtures/semantics/line-spacing.json' with { type: 'json' };
import footnotesFile from '../../fixtures/semantics/numbering-footnotes.json' with { type: 'json' };
import listsFile from '../../fixtures/semantics/numbering-lists.json' with { type: 'json' };
import projectionsFile from '../../fixtures/semantics/numbering-projections.json' with { type: 'json' };
import referencesFile from '../../fixtures/semantics/numbering-references.json' with { type: 'json' };
import sequencesFile from '../../fixtures/semantics/numbering-sequences.json' with { type: 'json' };
import spacingFile from '../../fixtures/semantics/paragraph-spacing.json' with { type: 'json' };
import tabsFile from '../../fixtures/semantics/tabs.json' with { type: 'json' };
import whitespaceFile from '../../fixtures/semantics/whitespace.json' with { type: 'json' };
import { dateFieldText } from '../numbering/dates.ts';
import {
  type CounterEffect,
  type DocumentLabels,
  computeLabels,
  counterEffects,
  referenceText,
} from '../numbering/labels.ts';
import { flowGaps, paragraphGap, type GapSide } from '../spacing/gaps.ts';
import { lineHeight } from '../spacing/lines.ts';
import { bodyFrame, footerFor, headerFor } from '../spacing/page.ts';
import { decimalIndex, nextTabStop, placeTab, type TabContext } from '../spacing/tabs.ts';
import { spaceRuns } from '../spacing/whitespace.ts';
import { validate } from '../validate/index.ts';
import type { LineRule, TabStop } from './resolve.ts';
import { resolveLabelRun, resolveParagraph, resolveRun } from './resolve.ts';
import { type TreeNode, eachChild, styleTable, typeOf } from './styles.ts';

type J = Record<string, unknown>;

interface Header {
  rule: string;
  spec: string;
  decision: string;
  implementation: string;
  description: string;
  format: string;
}

interface DefsFile extends Header {
  settings?: J;
  styles?: J[];
  numberings?: J[];
}

interface DocCase {
  id: string;
  description: string;
  valid?: boolean;
  settings?: J;
  styles?: J[];
  numberings?: J[];
  stories?: J[];
  body?: J[];
}

interface LabelExpectations {
  lists?: { id: string; text: string; kind?: string }[];
  sequences?: { holder: string; texts: string[] }[];
  equations?: { id: string; text: string }[];
  footnotes?: { id: string; text: string }[];
  references?: { target: string; text: string | null }[];
}

interface LabelCase extends DocCase {
  expected: LabelExpectations;
}

interface ProjectionCase extends LabelCase {
  fullBody: J[];
  hidden: string[];
  effects: Record<string, CounterEffect>;
  expectedWithoutEffects: LabelExpectations;
}

const files: Record<string, Header & { cases?: { id: string; description: string }[] }> = {
  'cascade.json': cascadeFile,
  'date-fields.json': dateFile,
  'header-growth.json': headerFile as never,
  'line-spacing.json': lineFile,
  'numbering-footnotes.json': footnotesFile as never,
  'numbering-lists.json': listsFile as never,
  'numbering-projections.json': projectionsFile as never,
  'numbering-references.json': referencesFile as never,
  'numbering-sequences.json': sequencesFile as never,
  'paragraph-spacing.json': spacingFile as never,
  'tabs.json': tabsFile as never,
  'whitespace.json': whitespaceFile,
};

function mergeById(base: readonly J[], extra: readonly J[]): J[] {
  const out = [...base];
  for (const n of extra) {
    const id = (n['attrs'] as J | undefined)?.['id'];
    const i = out.findIndex((m) => (m['attrs'] as J | undefined)?.['id'] === id);
    if (i >= 0) out[i] = n;
    else out.push(n);
  }
  return out;
}

/** The document of a case, assembled as each file's `format` says. */
function documentOf(file: DefsFile, c: DocCase, body: readonly J[] = c.body ?? []): TreeNode {
  const defs = {
    type: 'defs',
    content: [
      { type: 'settings', attrs: { ...file.settings, ...c.settings } },
      ...mergeById(file.styles ?? [], c.styles ?? []),
      ...mergeById(file.numberings ?? [], c.numberings ?? []),
      { type: 'page_setup', attrs: { id: 'ps1' } },
    ],
  };
  return {
    type: 'doc',
    content: [
      defs,
      ...(c.stories ?? []),
      { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
    ],
  } as unknown as TreeNode;
}

function expectValid(doc: TreeNode, c: DocCase): void {
  const result = validate({ cdm: 1, requires: [], doc });
  if (c.valid === false) expect(result.valid, 'the case is invalid on purpose').toBe(false);
  else expect(result.violations, `${c.id} is a valid CDM document`).toEqual([]);
}

function texts<T>(map: ReadonlyMap<string, T>, f: (v: T) => unknown): Record<string, unknown> {
  return Object.fromEntries([...map].map(([k, v]) => [k, f(v)]));
}

/** Checks every kind of label `expected` names: all of them (`exact`), or at least those listed. */
function expectLabels(labels: DocumentLabels, expected: LabelExpectations, exact = true): void {
  const check = (actual: Record<string, unknown>, wanted: Record<string, unknown>): void => {
    if (exact) expect(actual).toEqual(wanted);
    else for (const [k, v] of Object.entries(wanted)) expect(actual[k], k).toEqual(v);
  };
  if (expected.lists) {
    check(
      texts(labels.lists, (l) => l.text),
      Object.fromEntries(expected.lists.map((e) => [e.id, e.text])),
    );
    for (const e of expected.lists)
      if (e.kind) expect(labels.lists.get(e.id)?.kind, e.id).toBe(e.kind);
  }
  if (expected.sequences)
    check(
      texts(labels.sequences, (s) => s.map((x) => x.text)),
      Object.fromEntries(expected.sequences.map((e) => [e.holder, e.texts])),
    );
  if (expected.equations)
    check(
      texts(labels.equations, (t) => t),
      Object.fromEntries(expected.equations.map((e) => [e.id, e.text])),
    );
  if (expected.footnotes)
    check(
      texts(labels.footnotes, (t) => t),
      Object.fromEntries(expected.footnotes.map((e) => [e.id, e.text])),
    );
  for (const r of expected.references ?? [])
    expect(referenceText(labels, r.target), r.target).toBe(r.text);
}

describe('every fixture file is self-describing and reviewable (CDM-005)', () => {
  for (const [name, file] of Object.entries(files))
    it(name, () => {
      for (const key of ['rule', 'spec', 'decision', 'implementation', 'description', 'format'])
        expect(typeof (file as unknown as J)[key], `${name}: ${key}`).toBe('string');
      expect(file.decision).toBe('docs/adr/0032-layout-semantics.md');
      const groups = ['cases', 'pairs', 'flows', 'frames', 'slots']
        .map((g) => (file as unknown as J)[g])
        .filter((g): g is { id: string; description: string }[] => Array.isArray(g));
      expect(groups.length).toBeGreaterThan(0);
      const ids = new Set<string>();
      for (const c of groups.flat()) {
        expect(c.id, name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(ids.has(c.id), `${name}: ${c.id} is unique`).toBe(false);
        ids.add(c.id);
        expect(c.description, `${name}: ${c.id}`).toMatch(/^[^\n]{10,}$/);
      }
    });
});

describe('numbering fixtures (CDM-042)', () => {
  for (const [name, file] of [
    ['numbering-lists.json', listsFile],
    ['numbering-sequences.json', sequencesFile],
    ['numbering-footnotes.json', footnotesFile],
    ['numbering-references.json', referencesFile],
  ] as const) {
    const f = file as unknown as DefsFile & { cases: LabelCase[] };
    describe(name, () => {
      for (const c of f.cases)
        it(`${c.id}: ${c.description}`, () => {
          const doc = documentOf(f, c);
          expectValid(doc, c);
          expectLabels(computeLabels(doc), c.expected);
        });
    });
  }

  describe('numbering-projections.json (ADR 0019, SR-C3)', () => {
    const f = projectionsFile as unknown as DefsFile & { cases: ProjectionCase[] };
    for (const c of f.cases)
      it(`${c.id}: ${c.description}`, () => {
        const full = documentOf(f, c, c.fullBody);
        expectValid(full, c);
        const effects = counterEffects(full, c.hidden);
        expect(Object.fromEntries(effects)).toEqual(c.effects);
        const projection = documentOf(f, c);
        expectLabels(computeLabels(projection, { effects: c.effects }), c.expected);
        expectLabels(computeLabels(full), c.expected, false);
        expectLabels(computeLabels(projection), c.expectedWithoutEffects);
      });
  });
});

describe('cascade fixtures (CDM-041)', () => {
  interface CascadeCase extends DocCase {
    paragraph: J;
    context?: { tableStyle?: string };
    marks?: J[];
    expected: {
      error?: string;
      styleId?: string;
      numbering?: J;
      paragraph?: J;
      run?: J;
      labelRun?: J;
      layers?: Record<string, string>;
    };
  }
  const f = cascadeFile as unknown as DefsFile & { cases: CascadeCase[] };
  for (const c of f.cases)
    it(`${c.id}: ${c.description}`, () => {
      const paragraph = {
        type: 'paragraph',
        attrs: { id: 'p00xxxxxxxxxxxxx', ...c.paragraph },
        content: [{ type: 'text', text: 'Text', ...(c.marks ? { marks: c.marks } : {}) }],
      };
      const tableStyle = c.context?.tableStyle ?? null;
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
      const doc = documentOf(f, c, [block]);
      expectValid(doc, c);
      const table = styleTable(doc);
      const resolved = resolveParagraph(table, c.paragraph, { tableStyle, trace: true });
      if (c.expected.error) {
        expect(resolved.ok).toBe(false);
        if (!resolved.ok) expect(resolved.error.code).toBe(c.expected.error);
        return;
      }
      if (!resolved.ok) throw new Error(resolved.error.message);
      const p = resolved.value;
      if (c.expected.styleId) expect(p.styleId).toBe(c.expected.styleId);
      if (c.expected.numbering) expect(p.numbering).toEqual(c.expected.numbering);
      for (const [k, v] of Object.entries(c.expected.paragraph ?? {}))
        expect((p.properties as unknown as J)[k], k).toEqual(v);
      const run = resolveRun(table, p, c.marks as never, { trace: true });
      if (!run.ok) throw new Error(run.error.message);
      for (const [k, v] of Object.entries(c.expected.run ?? {}))
        expect((run.value as unknown as J)[k], k).toEqual(v);
      for (const [k, v] of Object.entries(c.expected.labelRun ?? {}))
        expect((resolveLabelRun(p) as unknown as J)[k], k).toEqual(v);
      for (const [k, layer] of Object.entries(c.expected.layers ?? {})) {
        const fromRun = c.marks !== undefined && k in (run.value.trace ?? {});
        expect(fromRun ? run.value.trace?.[k] : p.trace?.[k], k).toBe(layer);
      }
    });
});

describe('paragraph-spacing fixtures (CDM-043)', () => {
  interface FlowCase extends DocCase {
    expected: {
      container: string;
      gaps: { above: string | null; below: string | null; gap: number }[];
    }[];
  }
  const f = spacingFile as unknown as DefsFile & {
    pairs: {
      id: string;
      description: string;
      above: GapSide | null;
      below: GapSide | null;
      expected: number;
    }[];
    flows: FlowCase[];
  };
  for (const c of f.pairs)
    it(`${c.id}: ${c.description}`, () => expect(paragraphGap(c.above, c.below)).toBe(c.expected));

  /** The container with an id (a cell or a story), or the body, with the table style around it. */
  function find(doc: TreeNode, id: string): { node: TreeNode; tableStyle: string | null } | null {
    let found: { node: TreeNode; tableStyle: string | null } | null = null;
    const walk = (node: TreeNode, tableStyle: string | null): void => {
      if (found) return;
      const type = typeOf(node);
      const attrs = (node.attrs ?? {}) as J;
      if ((id === 'body' && type === 'body') || attrs['id'] === id) {
        found = { node, tableStyle };
        return;
      }
      const style =
        type === 'table' && typeof attrs['style'] === 'string' ? attrs['style'] : tableStyle;
      eachChild(node, (child) => walk(child, style));
    };
    walk(doc, null);
    return found;
  }
  for (const c of f.flows)
    it(`${c.id}: ${c.description}`, () => {
      const doc = documentOf(f, c);
      expectValid(doc, c);
      const table = styleTable(doc);
      for (const e of c.expected) {
        const container = find(doc, e.container);
        expect(container, e.container).not.toBeNull();
        const result = flowGaps(table, container!.node, { tableStyle: container!.tableStyle });
        expect(result.problems).toEqual([]);
        expect(result.gaps, e.container).toEqual(e.gaps);
      }
    });
});

describe('line-spacing fixtures (CDM-043)', () => {
  const f = lineFile as unknown as {
    cases: {
      id: string;
      description: string;
      lineSpacing: number;
      lineRule: LineRule;
      runs: number[];
      expected: number;
    }[];
  };
  for (const c of f.cases)
    it(`${c.id}: ${c.description}`, () =>
      expect(lineHeight({ lineSpacing: c.lineSpacing, lineRule: c.lineRule }, c.runs)).toBe(
        c.expected,
      ));
});

describe('tab fixtures (CDM-044)', () => {
  const f = tabsFile as unknown as {
    defaultTabStop: number;
    cases: {
      id: string;
      description: string;
      tabs: TabStop[];
      indentLeft?: number;
      indentFirstLine?: number;
      defaultTabStop?: number;
      x: number;
      segment?: { width: number; beforeDecimal?: number; text?: string };
      expected: J & { start?: number; decimalIndex?: number };
    }[];
  };
  for (const c of f.cases)
    it(`${c.id}: ${c.description}`, () => {
      const context: TabContext = {
        tabs: c.tabs,
        indentLeft: c.indentLeft ?? 0,
        indentFirstLine: c.indentFirstLine ?? 0,
        defaultTabStop: c.defaultTabStop ?? f.defaultTabStop,
      };
      const tab = nextTabStop(context, c.x) as unknown as J;
      const { start, decimalIndex: index, ...stop } = c.expected;
      for (const [k, v] of Object.entries(stop)) expect(tab[k], k).toEqual(v);
      if (c.segment) {
        const placed = placeTab(context, c.x, c.segment);
        if (start !== undefined) expect(placed.start).toBe(start);
        expect(placed.leaderFrom).toBe(c.x);
        if (index !== undefined) expect(decimalIndex(c.segment.text ?? '')).toBe(index);
      }
    });
});

describe('header-growth fixtures (CDM-045)', () => {
  const f = headerFile as unknown as {
    frames: {
      id: string;
      description: string;
      pageSetup: J;
      headerHeight: number;
      footerHeight: number;
      expected: J;
    }[];
    slots: {
      id: string;
      description: string;
      pageSetup: J;
      pages: {
        firstOfSection: boolean;
        even: boolean;
        header: string | null;
        footer: string | null;
      }[];
    }[];
  };
  for (const c of f.frames)
    it(`${c.id}: ${c.description}`, () => {
      const frame = bodyFrame(c.pageSetup, c) as unknown as J;
      for (const [k, v] of Object.entries(c.expected)) expect(frame[k], k).toBe(v);
    });
  for (const c of f.slots)
    it(`${c.id}: ${c.description}`, () => {
      for (const page of c.pages) {
        expect(headerFor(c.pageSetup, page)).toBe(page.header);
        expect(footerFor(c.pageSetup, page)).toBe(page.footer);
      }
    });
});

describe('date-field fixtures (03 §7, Fields; CDM-035)', () => {
  const f = dateFile as unknown as {
    cases: {
      id: string;
      description: string;
      instant: string;
      timeZone: string;
      format: string | null;
      expected: string | { error: string };
    }[];
  };
  for (const c of f.cases)
    it(`${c.id}: ${c.description}`, () => {
      const run = (): string =>
        dateFieldText({ instant: c.instant, timeZone: c.timeZone, format: c.format });
      if (typeof c.expected === 'string') expect(run()).toBe(c.expected);
      else expect(run).toThrow(RangeError);
    });
});

describe('whitespace fixtures (09 §3.2)', () => {
  const f = whitespaceFile as unknown as {
    cases: { id: string; description: string; text: string; expected: J[] }[];
  };
  for (const c of f.cases)
    it(`${c.id}: ${c.description}`, () => expect(spaceRuns(c.text)).toEqual(c.expected));
});
