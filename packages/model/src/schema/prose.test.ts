// The prose check (CDM-006; root README: the JSON Schema is "checked against the prose"): every node,
// mark and attribute named in the tables of 03 §3 to §5 is in the definition, and the reverse.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CDM1 } from '../definition/cdm1.ts';
import type { Grammar, MarkDef, NodeDef } from '../definition/grammar.ts';

const spec = readFileSync(
  resolve(import.meta.dirname, '../../../../docs/spec/03-document-model.md'),
  'utf8',
);

/** The text of one section, from its heading to the next heading of the same or a higher level. */
function section(heading: RegExp): string {
  const lines = spec.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) throw new Error(`no section ${heading}`);
  const level = /^#+/.exec(lines[start]!)![0].length;
  let end = start + 1;
  while (
    end < lines.length &&
    !(/^#+ /.test(lines[end]!) && /^#+/.exec(lines[end]!)![0].length <= level)
  )
    end++;
  return lines.slice(start + 1, end).join('\n');
}

const ticked = (s: string): string[] =>
  [...s.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]!);

/** Removes parenthesised groups, which hold values and notes, not attribute names. */
function withoutParentheses(s: string): string {
  let out = '';
  let depth = 0;
  for (const c of s) {
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += c;
  }
  return out;
}

/** Table rows of a section as cells, header first; `\|` inside a cell is not a separator. */
function tables(text: string): string[][][] {
  const out: string[][][] = [];
  let current: string[][] | null = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) {
      current = null;
      continue;
    }
    if (/^\|[-| :]+\|$/.test(line)) continue;
    const cells = line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
    if (!current) out.push((current = []));
    current.push(cells);
  }
  return out;
}

interface ProseEntry {
  kind: 'node' | 'mark';
  /** Attribute names, or null when the attributes are defined elsewhere (12). */
  attrs: Set<string> | null;
  /** Sub-properties named after `name:` (the levels of a numbering definition). */
  sub: Map<string, Set<string>>;
}

function prose(): { entries: Map<string, ProseEntry>; blockGroup: string[] } {
  const entries = new Map<string, ProseEntry>();
  const formatting = section(/^### 4\.5 /);
  const listAfter = (label: RegExp): string[] => {
    const line = formatting.split('\n').find((l) => label.test(l));
    if (!line) throw new Error(`no ${label} in 03 §4.5`);
    return ticked(withoutParentheses(line.replace(label, '')));
  };
  const run = listAfter(/^Run properties:/);
  const paragraphProps = listAfter(/^Paragraph properties:/);
  const tableProps = listAfter(/^Table properties \(table styles only\):/);

  const read = (heading: RegExp, kindOf: (row: string[], header: string[]) => 'node' | 'mark') => {
    for (const table of tables(section(heading))) {
      const header = table[0]!;
      const attrCol = header.findIndex((h) => h === 'Attributes');
      for (const row of table.slice(1)) {
        const names = ticked(row[0]!);
        const cell = row[attrCol] ?? '';
        let attrs: Set<string> | null = new Set();
        const sub = new Map<string, Set<string>>();
        if (/Defined in 12/.test(cell)) attrs = null;
        else {
          const plain = withoutParentheses(cell);
          const colon = /`([A-Za-z_]+)`:/.exec(plain);
          const before = colon ? plain.slice(0, colon.index + colon[0].length) : plain;
          for (const n of ticked(before)) attrs.add(n);
          if (colon)
            sub.set(colon[1]!, new Set(ticked(plain.slice(colon.index + colon[0].length))));
          if (/formatting properties in 4\.5/.test(cell))
            for (const n of [...run, ...paragraphProps, ...tableProps]) attrs.add(n);
          else if (/paragraph properties in 4\.5/.test(cell))
            for (const n of paragraphProps) attrs.add(n);
        }
        for (const name of names) entries.set(name, { kind: kindOf(row, header), attrs, sub });
      }
    }
  };
  read(/^### 4\.1 /, () => 'node');
  read(/^### 4\.2 /, () => 'node');
  read(/^### 4\.3 /, () => 'node');
  read(/^### 4\.4 /, () => 'node');
  read(/^### 4\.6 /, (row, header) =>
    /mark/i.test(row[header.indexOf('Kind')] ?? '') ? 'mark' : 'node',
  );
  read(/^## 5\. Marks/, () => 'mark');

  // 03 §3: the tree names the root and the definition nodes; one sentence defines `block`.
  const structure = section(/^## 3\. Structure/);
  for (const m of structure.matchAll(/^[\s│├└─]*([a-z_]+)\b/gm))
    if (!entries.has(m[1]!) && m[1] !== 'block')
      entries.set(m[1]!, { kind: 'node', attrs: new Set(), sub: new Map() });
  const blockLine = structure.split('\n').find((l) => /^`block` means one of/.test(l))!;
  const blockGroup = ticked(blockLine).slice(1);
  return { entries, blockGroup };
}

/**
 * Attributes in the definition that the per-node tables do not list, each with the sentence of
 * the spec or the decision that adds it. Anything else missing from the prose fails the check.
 */
const ON_EVERY_NODE_AND_MARK = 'ext'; // 03 §4 and §11.2
const PRESERVED_HOSTS = [
  // 03 §4.6: "Block and definition nodes also have a core attribute `preserved`".
  'settings',
  'style_def',
  'numbering_def',
  'page_setup',
  'source_def',
  'bibliography',
  'story',
  'region',
  'section_break',
  'paragraph',
  'table',
  'table_row',
  'table_cell',
  'figure',
  'equation_block',
  'toc',
];
/**
 * Ahead of the prose: the definition also gives these inline atoms `preserved`. ADR 0017 leaves
 * them to spike S11 ("Inline atoms without identifiers"), and 03 §4.6 does not name them.
 */
const AHEAD_OF_PROSE = [
  'image.preserved',
  'equation.preserved',
  'footnote.preserved',
  'field.preserved',
  'citation.preserved',
];
/** 03 §4.6: "Inline atoms without a preserved fragment of their own … have a core attribute `origin`". */
const ORIGIN_HOSTS = ['image', 'equation', 'field', 'footnote', 'anchor', 'citation'];

describe('the definition against the prose of 03 (CDM-006)', () => {
  const { entries, blockGroup } = prose();
  const defined = new Map<string, { kind: 'node' | 'mark'; def: NodeDef | MarkDef }>([
    ...CDM1.nodes.map((n) => [n.name, { kind: 'node' as const, def: n }] as const),
    ...CDM1.marks.map((m) => [m.name, { kind: 'mark' as const, def: m }] as const),
  ]);

  it('finds the tables it reads (the check is not vacuous)', () => {
    expect(entries.size).toBeGreaterThan(40);
    expect(entries.get('page_setup')?.attrs?.size).toBe(24);
  });

  it('names the same nodes and marks', () => {
    const prosed = [...entries].map(([n, e]) => `${e.kind} ${n}`).sort();
    const def = [...defined].map(([n, d]) => `${d.kind} ${n}`).sort();
    expect(def).toEqual(prosed);
  });

  it('names every attribute of the prose in the definition, and the reverse', () => {
    const missing: string[] = [];
    const extra: string[] = [];
    for (const [name, entry] of entries) {
      const d = defined.get(name);
      if (!d || !entry.attrs) continue; // nodes of 12 are checked by FRW
      const attrs = new Set(Object.keys(d.def.attrs));
      for (const a of entry.attrs) if (!attrs.has(a)) missing.push(`${name}.${a}`);
      for (const a of attrs) {
        if (entry.attrs.has(a) || a === ON_EVERY_NODE_AND_MARK) continue;
        if (a === 'preserved' && d.kind === 'node' && PRESERVED_HOSTS.includes(name)) continue;
        if (a === 'origin' && d.kind === 'node' && ORIGIN_HOSTS.includes(name)) continue;
        if (AHEAD_OF_PROSE.includes(`${name}.${a}`)) continue;
        extra.push(`${name}.${a}`);
      }
    }
    expect(missing, 'in the prose, missing from the definition').toEqual([]);
    expect(extra, 'in the definition, missing from the prose').toEqual([]);
  });

  it('gives every node and mark `ext`, and lists the levels of a numbering definition', () => {
    for (const [name, d] of defined)
      if (name !== 'text') expect(d.def.attrs, name).toHaveProperty('ext');
    const levels = CDM1.nodes.find((n) => n.name === 'numbering_def')!.attrs['levels']!
      .grammar as Grammar;
    expect(levels.kind).toBe('array');
    const item = levels.kind === 'array' ? levels.items : levels;
    const props = item.kind === 'object' ? Object.keys(item.properties).sort() : [];
    expect(props).toEqual([...entries.get('numbering_def')!.sub.get('levels')!].sort());
  });

  it('puts in the `block` group the blocks of 03 §3 and the preserved block of 03 §4.6', () => {
    const group = CDM1.nodes
      .filter((n) => (n.group ?? '').split(' ').includes('block'))
      .map((n) => n.name)
      .sort();
    expect(group).toEqual([...blockGroup, 'preserved_block'].sort());
  });
});
