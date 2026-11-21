// The layout semantics of 03 §6 and §7 against the fixtures (CDM-005, last criterion): ADR 0032 was
// accepted by the owner (decisions 9, 10 and 11 of docs/owner-decisions-2026-11-15.md), 03 §7 now
// states its rules, and the fixtures are in packages/model for CDM-042 to CDM-045. This test reads
// 03 and checks that it names every fixture file and no other, and that the statements the owner
// decided are the ones the fixtures hold. semantics-fixtures.universal.test.ts runs every fixture
// against the implementation; this file ties the specification to them. Node.js only.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
