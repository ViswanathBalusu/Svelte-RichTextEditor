// The layout semantics of 03 §6 and §7 against the fixtures (CDM-005, last criterion): ADR 0032 was
// accepted by the owner (decisions 9, 10 and 11 of docs/owner-decisions-2026-11-15.md), 03 §7 now
// states its rules, and the fixtures are in packages/model for CDM-042 to CDM-045. This test reads
// 03 and checks that it names every fixture file and no other, and that the statements the owner
// decided are the ones the fixtures hold. semantics-fixtures.universal.test.ts runs every fixture
// against the implementation; this file ties the specification to them. Node.js only.
//
// The second describe block is the review of 2026-11-20 (CDM-005, lane w6): the places where 03 was
// less exact than the fixtures, so that an engine written from 03 alone could fail a case (how
// letters continue after z, the footnote symbols after the eighth mark, runs of letters in a date
// picture, the order of tab stops, the kind of stop a hanging indent gives, the footnote's paragraph
// in a table). Each sentence added to 03 is read here beside the fixture case and the code.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addDefs,
  bodyOf,
  cell,
  codes,
  exampleDoc,
  footnote,
  para,
  row,
  style,
  table as tableNode,
  text,
  type Json,
} from '../../test/support.ts';
import { dateFieldText } from '../numbering/dates.ts';
import { footnoteMark, formatNumber } from '../numbering/format.ts';
import { computeLabels, referenceText } from '../numbering/labels.ts';
import { nextTabStop } from '../spacing/tabs.ts';
import type { TabStop } from './resolve.ts';

const root = resolve(import.meta.dirname, '../../../..');
const dir = resolve(root, 'packages/model/fixtures/semantics');
const spec = readFileSync(resolve(root, 'docs/spec/03-document-model.md'), 'utf8');
const adr = readFileSync(resolve(root, 'docs/adr/0032-layout-semantics.md'), 'utf8');

/** The text of a `## n.` section of 03, subsections included. */
function section(number: number): string {
  const lines = spec.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${number}. `));
  if (start < 0) throw new Error(`03 has no section ${number}`);
  let end = start + 1;
  while (end < lines.length && !/^## /.test(lines[end]!)) end++;
  return lines.slice(start, end).join('\n');
}
const cascade = section(6);
const semantics = section(7);

interface Fixture {
  rule: string;
  spec: string;
  decision: string;
  format: string;
  cases?: Array<{ id: string; [key: string]: unknown }>;
  frames?: Array<{ id: string; expected: Record<string, number> }>;
}
const names = readdirSync(dir)
  .filter((n) => n.endsWith('.json'))
  .sort();
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as Fixture;
const caseOf = (name: string, id: string): Record<string, unknown> => {
  const found = fixture(name).cases?.find((c) => c.id === id);
  if (!found) throw new Error(`${name} has no case ${id}`);
  return found;
};

/** The fixture files the table of 03 §7 names, by topic. */
function table(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of semantics.split('\n')) {
    if (!line.startsWith('| ') || /^\|[-| ]+\|$/.test(line)) continue;
    const cells = line.slice(1, -1).split(' | ');
    const topic = cells[0]!.trim();
    if (topic === 'Topic') continue;
    out.set(
      topic,
      [...cells.at(-1)!.matchAll(/`([a-z-]+\.json)`/g)].map((m) => m[1]!),
    );
  }
  return out;
}

describe('03 §6 and §7 against the semantics fixtures (CDM-005; ADR 0032, accepted)', () => {
  it('names the decision record and the three owner decisions, and the record is accepted', () => {
    expect(semantics).toContain('adr/0032-layout-semantics.md');
    expect(semantics).toContain('owner-decisions-2026-11-15.md');
    expect(semantics).toMatch(/decisions 9, 10 and 11/);
    expect(adr).toMatch(/^\*\*Status:\*\* accepted\./m);
    for (const n of [9, 10, 11]) expect(adr).toContain(`decision ${n}`);
  });

  it('names every fixture file of packages/model/fixtures/semantics, and no other', () => {
    const rows = table();
    expect([...rows.keys()]).toEqual([
      'Numbering',
      'Paragraph spacing',
      'Line spacing',
      'Tabs',
      'Header growth',
      'Spaces',
      'Fields',
    ]);
    const inTable = [...rows.values()].flat();
    // The cascade's file is named in the sentence after the table (its rules are section 6).
    expect(semantics).toMatch(
      /cascade of section 6 has its fixtures in the same folder, in `cascade\.json`/,
    );
    expect([...inTable, 'cascade.json'].sort()).toEqual(names);
    expect(names).toHaveLength(12);
    expect(semantics).toContain('`packages/model/fixtures/semantics/`');
  });

  it('has a detail section for each topic of the table, and every file cites the record', () => {
    for (const heading of [
      '### 7.1 Numbering',
      '### 7.2 Paragraph spacing',
      '### 7.3 Line spacing',
      '### 7.4 Tabs',
      '### 7.5 Header and footer growth',
      '### 7.6 Spaces',
      '### 7.7 Date fields',
    ])
      expect(semantics, heading).toContain(`\n${heading}\n`);
    for (const name of names) {
      const f = fixture(name);
      expect(f.decision, name).toBe('docs/adr/0032-layout-semantics.md');
      expect(f.format.length, name).toBeGreaterThan(40);
      const cases = f.cases ?? f.frames ?? [];
      if (name !== 'paragraph-spacing.json') expect(cases.length, name).toBeGreaterThan(0);
      for (const c of cases) expect(typeof c.id, name).toBe('string');
    }
  });

  it('decision 9: the numbering level comes after the paragraph style, in 03 §6 and in the fixture', () => {
    const order = [...cascade.matchAll(/^(\d)\. (.+)$/gm)].map((m) => m[2]!);
    expect(order[2]).toMatch(/^The paragraph style chain/);
    expect(order[3]).toMatch(/^The numbering level's paragraph properties/);
    expect(order[3]).toMatch(/owner decision 9/);
    expect(order[4]).toMatch(/^Direct paragraph attributes/);
    const c = caseOf('cascade.json', 'numbering-level-over-paragraph-style');
    expect(String(c['description'])).toMatch(/level/i);
    expect(caseOf('cascade.json', 'direct-over-numbering-level')).toBeDefined();
  });

  it('gives in 03 §6 the base values and the whole-value rule that the cascade fixtures hold', () => {
    expect(cascade).toContain('adr/0032-layout-semantics.md');
    expect(cascade).toContain('`cascade.json`');
    const base = caseOf('cascade.json', 'base-values')['expected'] as {
      paragraph: Record<string, unknown>;
      run: Record<string, unknown>;
    };
    const stated = (pattern: RegExp): number => Number(pattern.exec(cascade)![1]);
    expect(stated(/a `lineSpacing` of (\d+) under `multiple`/)).toBe(base.paragraph['lineSpacing']);
    expect(base.paragraph['lineRule']).toBe('multiple');
    expect(stated(/a `fontSize` of (\d+)/)).toBe(base.run['fontSize']);
    expect(cascade).toContain('`align: start`');
    expect(base.paragraph['align']).toBe('start');
    expect(cascade).toContain('`widowControl` on and every other boolean off');
    const booleans = Object.entries(base.paragraph).filter(([, v]) => typeof v === 'boolean');
    expect(booleans.filter(([, v]) => v === true).map(([k]) => k)).toEqual(['widowControl']);
    expect(cascade).toContain('`underline: none`, `vertAlign: baseline`');
    expect([base.run['underline'], base.run['vertAlign']]).toEqual(['none', 'baseline']);
    expect([base.run['color'], base.run['highlight'], base.run['fontFamily']]).toEqual([
      null,
      null,
      null,
    ]);
    // The whole-value rule and the cleared tab stops have cases of their own.
    for (const id of [
      'tabs-are-a-whole-value',
      'empty-tabs-clear-inherited-stops',
      'paragraph-numbering-over-style-numbering',
      'default-style-is-layer-1',
      'table-style-over-default-style',
      'level-run-properties-format-the-label-only',
      'missing-style-is-a-typed-error',
    ])
      expect(caseOf('cascade.json', id), id).toBeDefined();
  });

  it('decision 11: a projection shows the numbers of the full document', () => {
    expect(semantics).toMatch(
      /sees the numbers of the full document, and gaps may show \(owner decision 11\)/,
    );
    const cases = fixture('numbering-projections.json').cases ?? [];
    expect(cases.length).toBeGreaterThanOrEqual(3);
    for (const c of cases) {
      expect(c, c.id).toHaveProperty('effects');
      expect(c, c.id).toHaveProperty('expected');
      expect(c, c.id).toHaveProperty('expectedWithoutEffects');
    }
  });

  it('states the numbers the fixtures hold: a skipped level, the rounding of a line, a page with no room', () => {
    // 7.1: level 0 followed by level 2 gives "1.0.1".
    expect(semantics).toContain('level 0 followed by level 2 gives "1.0.1"');
    const skipped = caseOf('numbering-lists.json', 'skipped-level')['expected'] as {
      lists: Array<{ text: string }>;
    };
    expect(skipped.lists.map((l) => l.text)).toContain('1.0.1');
    // 7.3: 1150 thousandths of 253 twips is 290.95 and gives 291 (owner decision 78).
    const stated =
      /(\d+) thousandths of (\d+) twips is ([\d.]+) and gives (\d+) \(owner decision 78\)/.exec(
        semantics,
      )!;
    const rounding = caseOf('line-spacing.json', 'rounding');
    expect(Number(stated[1])).toBe(rounding['lineSpacing']);
    expect([Number(stated[2])]).toEqual(rounding['runs']);
    expect(Number(stated[4])).toBe(rounding['expected']);
    expect((Number(stated[1]) * Number(stated[2])) / 1000).toBeCloseTo(Number(stated[3]), 10);
    expect(Math.floor((Number(stated[1]) * Number(stated[2])) / 1000 + 0.5)).toBe(
      Number(stated[4]),
    );
    // 7.5: no room means an empty first page and a body that starts on the next (owner decision 77).
    expect(semantics).toMatch(
      /the body starts on the next page at the same top \(owner decision 77\)/,
    );
    const frame = fixture('header-growth.json').frames!.find(
      (f) => f.id === 'nothing-left-for-the-body',
    )!;
    expect(frame.expected['height']).toBe(0);
    expect(frame.expected['startsOnPage']).toBe(2);
  });

  it('states the footnote symbols and the date picture tokens the fixtures use', () => {
    expect(semantics).toContain('cycles * † ‡ §');
    expect(JSON.stringify(caseOf('numbering-footnotes.json', 'symbols'))).toMatch(/†/);
    const tokens = /tokens (.+?);/.exec(semantics)![1]!;
    expect([...tokens.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1])).toEqual([
      'yyyy',
      'yy',
      'MM',
      'M',
      'dd',
      'd',
      'HH',
      'H',
      'mm',
      'ss',
    ]);
    const dates = JSON.stringify(fixture('date-fields.json').cases);
    expect(dates).toContain('yyyy-MM-dd');
  });
});

describe('03 §6 and §7 are as exact as the fixtures (CDM-005, review of 2026-11-20)', () => {
  interface ListCase {
    body: Array<{
      attrs: { id: string; numbering?: { listId: string }; numberingRestart?: number };
    }>;
    expected: { lists: Array<{ id: string; text: string }> };
  }
  /**
   * The counter value behind each label of a list case whose levels start at 1 and have the template
   * `%1`: a restart sets the value and the next paragraph of the list adds one. Lower case.
   */
  function valuesOf(id: string): Map<number, string> {
    const c = caseOf('numbering-lists.json', id) as unknown as ListCase;
    const counters = new Map<string, number>();
    const value = new Map<string, number>();
    for (const p of c.body) {
      const list = p.attrs.numbering?.listId;
      if (list === undefined) continue;
      // A restart sets the value; without one the list's last value grows by one, from 0.
      const next = p.attrs.numberingRestart ?? (counters.get(list) ?? 0) + 1;
      counters.set(list, next);
      value.set(p.attrs.id, next);
    }
    return new Map(c.expected.lists.map((l) => [value.get(l.id)!, l.text.toLowerCase()]));
  }

  it('says how letters continue after z and Roman numerals after 3999, with the numbers of the fixtures', () => {
    const sentence = /Letters run a to z and then repeat the letter, as Word does: ([^.]+)\./.exec(
      semantics,
    );
    expect(sentence).not.toBeNull();
    const stated = new Map(
      [...sentence![1]!.matchAll(/(\d+) is ([a-z]+)/g)].map((m) => [Number(m[1]), m[2]!] as const),
    );
    expect([...stated.keys()]).toEqual([26, 27, 28, 52, 53]);
    // The fixture holds exactly these five values, the upper-case one included.
    expect(new Map([...valuesOf('letters-past-z')].sort((a, b) => a[0] - b[0]))).toEqual(stated);
    for (const [n, letters] of stated) {
      expect(formatNumber(n, 'lowerLetter'), String(n)).toBe(letters);
      expect(formatNumber(n, 'upperLetter'), String(n)).toBe(letters.toUpperCase());
    }
    // Not the letters of a spreadsheet column, which would give ab for 28.
    expect(stated.get(28)).toBe('bb');

    const roman = /thousands beyond three as repeated m, so (\d+) is (m+)\./.exec(semantics);
    expect(roman).not.toBeNull();
    expect(valuesOf('roman-numerals').get(Number(roman![1]))).toBe(roman![2]);
    expect(formatNumber(Number(roman![1]), 'lowerRoman')).toBe(roman![2]);
    expect(valuesOf('roman-numerals').get(3999)).toBe('mmmcmxcix');
  });

  it('says how the footnote symbols continue after the eighth mark, as the fixture has them', () => {
    const sentence = /the fifth mark is `(\*+)` and the ninth is `(\*+)`\./.exec(semantics);
    expect(sentence).not.toBeNull();
    const marks = (
      caseOf('numbering-footnotes.json', 'symbols')['expected'] as {
        footnotes: Array<{ text: string }>;
      }
    ).footnotes.map((f) => f.text);
    expect(marks).toHaveLength(9);
    expect([marks[4], marks[8]]).toEqual([sentence![1], sentence![2]]);
    expect(marks).toEqual(marks.map((_m, i) => footnoteMark(i + 1, 'symbol')));
    expect(semantics).toContain('then doubles them, then triples them, and so on');
  });

  it('says how a date picture is read: runs of one character, and a run that is no token stays', () => {
    expect(semantics).toContain('The picture is read in runs of one repeated character');
    expect(semantics).toContain('so `MMMM` stays `MMMM`');
    const monthNames = caseOf('date-fields.json', 'month-names-are-not-supported');
    expect([monthNames['format'], monthNames['expected']]).toEqual(['MMMM yyyy', 'MMMM 2026']);
    const at = (format: string, instant = '2026-01-05T07:08:09.000Z'): string =>
      dateFieldText({ instant, timeZone: 'UTC', format });
    expect(at('MMMM yyyy')).toBe('MMMM 2026');
    // Two tokens side by side are two runs, and a run that is not a token is kept: not 2026 + y.
    expect(at('ddMM')).toBe('0501');
    expect(at('yyyyy yyy y')).toBe('yyyyy yyy y');
    // "yyyy is the year in four digits and yy its last two; MM, dd, HH, mm and ss have two digits;
    // M, d and H are not padded."
    expect(semantics).toContain('`M`, `d` and `H` are not padded');
    expect(at('yyyy yy MM M dd d HH H mm ss')).toBe('2026 26 01 1 05 5 07 7 08 09');
    expect(caseOf('date-fields.json', 'short-tokens')['expected']).toBe('5.1.26');
    // "The hour runs from 0 to 23."
    expect(semantics).toContain('The hour runs from 0 to 23.');
    expect(at('H', '2026-01-05T00:30:00.000Z')).toBe('0');
    expect(at('HH', '2026-01-05T23:30:00.000Z')).toBe('23');
    expect(caseOf('date-fields.json', 'zone-behind')['expected']).toBe('2026-11-06 15:30');
    // The decision record says the same.
    expect(adr).toContain('a run of letters that is not a token is kept as written');
  });

  it('says in 03 §6 that stops come out in position order and that a later entry wins a position', () => {
    expect(cascade).toContain(
      'The resolved stops are in position order, and when two entries of a list share a position the later one wins.',
    );
    interface TabCase {
      paragraph: { tabs: TabStop[] };
      expected: { paragraph: { tabs: TabStop[] } };
    }
    const whole = caseOf('cascade.json', 'tabs-are-a-whole-value') as unknown as TabCase;
    expect(whole.paragraph.tabs.map((t) => t.position)).toEqual([6000, 3000]);
    expect(whole.expected.paragraph.tabs.map((t) => t.position)).toEqual([3000, 6000]);
    const shared = caseOf('cascade.json', 'duplicate-tab-positions') as unknown as TabCase;
    expect(shared.paragraph.tabs.map((t) => t.position)).toEqual([2000, 2000]);
    expect(shared.expected.paragraph.tabs).toEqual([shared.paragraph.tabs[1]]);
  });

  it('says in 03 §7.4 what kind of stop a hanging indent and a default stop are, and tabs.json can tell', () => {
    expect(semantics).toContain(
      'The stop of a hanging indent and the default stops are left stops without a leader.',
    );
    expect(semantics).toContain('it need not lie on a multiple of `settings.defaultTabStop`');
    const tabs = fixture('tabs.json') as unknown as {
      defaultTabStop: number;
      cases: Array<{
        id: string;
        tabs: TabStop[];
        indentLeft?: number;
        indentFirstLine?: number;
        x: number;
        expected: { position: number; align?: string; leader?: string; source: string };
      }>;
    };
    const implicit = tabs.cases.filter((c) => c.expected.source !== 'stop');
    expect(implicit.map((c) => c.expected.source)).toContain('hanging');
    expect(implicit.map((c) => c.expected.source)).toContain('default');
    for (const c of implicit) {
      if (c.expected.align !== undefined) expect(c.expected.align, c.id).toBe('left');
      if (c.expected.leader !== undefined) expect(c.expected.leader, c.id).toBe('none');
      const stop = nextTabStop(
        {
          tabs: c.tabs,
          indentLeft: c.indentLeft ?? 0,
          indentFirstLine: c.indentFirstLine ?? 0,
          defaultTabStop: tabs.defaultTabStop,
        },
        c.x,
      );
      expect([stop.position, stop.align, stop.leader], c.id).toEqual([
        c.expected.position,
        'left',
        'none',
      ]);
    }
    // One hanging-indent stop lies on no default stop, so an engine that has only the default
    // stops fails that case. Before 2026-11-20 no case could tell the two apart.
    const off = tabs.cases.filter(
      (c) => c.expected.source === 'hanging' && c.expected.position % tabs.defaultTabStop !== 0,
    );
    expect(off.map((c) => c.id)).toEqual(['hanging-indent-off-the-default-stops']);
    for (const c of off) {
      const withoutTheRule = nextTabStop(
        { tabs: c.tabs, indentLeft: 0, indentFirstLine: 0, defaultTabStop: tabs.defaultTabStop },
        c.x,
      );
      expect(withoutTheRule.position).not.toBe(c.expected.position);
    }
  });

  it('says in 03 §6 that the paragraph of a footnote takes no table style, as the label walk does', () => {
    expect(cascade).toContain(
      'The paragraph of a footnote takes no table style, even when the footnote stands in a table cell',
    );
    // A table style may carry `numbering`, which resolves through the style layers. The paragraphs
    // of the cell take it. The paragraph of a footnote in the cell does not.
    const d = exampleDoc();
    addDefs(
      d,
      style('NumberedCells', {
        kind: 'table',
        numbering: { numberingId: 'cellList', level: 0, listId: 'listInTheTable01' },
      }),
      {
        type: 'numbering_def',
        attrs: {
          id: 'cellList',
          name: 'Cell list',
          levels: [{ format: 'decimal', text: '%1.', start: 1 }],
        },
      },
    );
    bodyOf(d).push(
      tableNode(
        'tStyledTable0001',
        [9000],
        [
          row('rOnlyRow00000001', [
            cell('cOnlyCell0000001', [
              para('pInTheCell000001', [
                text('cell'),
                footnote('fInTheCell000001', [para('pInTheNote000001', 'note')]),
              ]),
              para('pInTheCell000002', 'cell'),
            ]),
          ]),
        ],
        { style: 'NumberedCells' },
      ),
      para('pAfterTheTable01', 'after'),
    );
    expect(codes(d)).toEqual([]);
    const labels = computeLabels(d['doc']);
    expect([...labels.lists].map(([id, label]) => [id, label.text])).toEqual([
      ['pInTheCell000001', '1.'],
      ['pInTheCell000002', '2.'],
    ]);
    expect(labels.lists.has('pInTheNote000001')).toBe(false);
    expect(labels.footnotes.get('fInTheCell000001')).toBe('1');
    // The decision record has the rule in its section on numbering.
    expect(adr).toMatch(/Footnote content \|[^|]*No table style applies to it/);
  });

  it('says what the algorithm gives no text to, and what an opaque block counts', () => {
    expect(semantics).toContain('This algorithm gives no text to a `styleRef` field');
    const styleRef = caseOf('numbering-references.json', 'style-reference-is-not-computed-here')[
      'expected'
    ] as { references: Array<{ target: string; text: string | null }> };
    expect(styleRef.references).toEqual([{ target: 'style:Heading1', text: null }]);
    const labels = computeLabels(exampleDoc()['doc']);
    expect(referenceText(labels, 'style:Heading1')).toBeNull();
    expect(referenceText(labels, 'field:client.name')).toBeNull();
    expect(semantics).toContain('Without an effect the placeholder counts nothing.');
    expect(semantics).toContain(
      'A preserved block and an extension block count nothing of their own either.',
    );
    // A preserved block between two items of a list changes no label.
    const item = (id: string): Json =>
      para(id, 'item', {
        numbering: { numberingId: 'plain', level: 0, listId: 'listAroundBlock1' },
      });
    const numbered = (between: Json[]): string[] => {
      const d = exampleDoc();
      addDefs(d, {
        type: 'numbering_def',
        attrs: {
          id: 'plain',
          name: 'Plain',
          levels: [{ format: 'decimal', text: '%1', start: 1 }],
        },
      });
      bodyOf(d).push(item('pItemBefore00001'), ...between, item('pItemAfter000001'));
      return [...computeLabels(d['doc']).lists.values()].map((l) => l.text);
    };
    const opaque = (type: string): Json => ({
      type,
      attrs: { id: `b${type.replace(/_/g, '').padEnd(15, '0').slice(0, 15)}` },
    });
    expect(numbered([])).toEqual(['1', '2']);
    for (const type of ['preserved_block', 'extension_block', 'hidden_region'])
      expect(numbered([opaque(type)]), type).toEqual(['1', '2']);
  });

  it('numbers the layers in the decision record as 03 §6 does', () => {
    const order = [...cascade.matchAll(/^(\d)\. (.+)$/gm)].map((m) => m[2]!);
    expect(order[1]).toMatch(/^The table style/);
    expect(order[2]).toMatch(/^The paragraph style chain/);
    expect(order[3]).toMatch(/^The numbering level/);
    expect(adr).toContain('| Layers 1 and 3 both reach the default paragraph style');
    expect(adr).toContain('| What layer 4 contributes | The level');
    expect(adr).toContain('`numbering` resolves like a property through layers 1, 2 and 3');
    // The numbers of the text of 2026-11-06, when the numbering level was layer 3.
    for (const old of ['Layers 1 and 4', 'What layer 3 contributes', 'layers 1, 2 and 4'])
      expect(adr, old).not.toContain(old);
    expect(cascade).toContain('is not applied again in layer 3');
  });
});
