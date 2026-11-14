// The definition itself (CDM-006, CDM-002, CDM-051): generation refuses an incomplete grammar and
// names the attribute, integer ranges stay interoperable, and the preservation feature is declared.
import { describe, expect, it } from 'vitest';
import { MAX_INTEROPERABLE_INTEGER } from '../conventions/validators.ts';
import { CDM1 } from '../definition/cdm1.ts';
import type { AttrDef, CdmDefinition, Grammar } from '../definition/grammar.ts';
import { checkDefinition } from './check-definition.ts';

/** A copy of CDM 1 with one attribute of `paragraph` replaced. */
function withParagraphAttr(name: string, attr: unknown): CdmDefinition {
  return {
    ...CDM1,
    nodes: CDM1.nodes.map((n) =>
      n.name === 'paragraph' ? { ...n, attrs: { ...n.attrs, [name]: attr as AttrDef } } : n,
    ),
  };
}

function grammars(g: Grammar, out: Grammar[] = []): Grammar[] {
  out.push(g);
  if (g.kind === 'object') for (const sub of Object.values(g.properties)) grammars(sub, out);
  if (g.kind === 'array') grammars(g.items, out);
  return out;
}

describe('the CDM definition', () => {
  it('fails generation for an attribute with an incomplete grammar or no default, naming it', () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ['noGrammar', { default: null, doc: 'x' }, /node paragraph\.noGrammar: no grammar/],
      [
        'noDefault',
        { grammar: { kind: 'boolean' }, doc: 'x' },
        /node paragraph\.noDefault: no default/,
      ],
      [
        'noLength',
        { grammar: { kind: 'string' }, default: '', doc: 'x' },
        /node paragraph\.noLength: string without a maximum length/,
      ],
      [
        'noRange',
        { grammar: { kind: 'integer', min: 0 }, default: 0, doc: 'x' },
        /node paragraph\.noRange: integer without a range/,
      ],
      [
        'hugeRange',
        { grammar: { kind: 'integer', min: 0, max: 2 ** 60 }, default: 0, doc: 'x' },
        /node paragraph\.hugeRange: integer without a range inside the interoperable range/,
      ],
      [
        'noValues',
        { grammar: { kind: 'enum', values: [] }, default: null, doc: 'x' },
        /node paragraph\.noValues: enumeration without values/,
      ],
      [
        'badPattern',
        { grammar: { kind: 'string', maxLength: 4, pattern: '[a-z]+' }, default: 'a', doc: 'x' },
        /node paragraph\.badPattern: pattern is not anchored/,
      ],
      [
        'noBound',
        { grammar: { kind: 'json' }, default: null, doc: 'x' },
        /node paragraph\.noBound: free JSON without a size and depth bound/,
      ],
      [
        'badDefault',
        { grammar: { kind: 'integer', min: 0, max: 9 }, default: 10, doc: 'x' },
        /default is invalid: node paragraph\.badDefault: 10 is outside 0 to 9/,
      ],
    ];
    for (const [name, attr, expected] of cases) {
      const problems = checkDefinition(withParagraphAttr(name, attr));
      expect(problems.join('\n'), name).toMatch(expected);
    }
  });

  it('keeps every integer range inside the interoperable range of RFC 8785 (CDM-002)', () => {
    for (const owner of [...CDM1.nodes, ...CDM1.marks])
      for (const [name, a] of Object.entries(owner.attrs))
        for (const g of grammars(a.grammar))
          if (g.kind === 'integer') {
            expect(Math.abs(g.min), `${owner.name}.${name}`).toBeLessThanOrEqual(
              MAX_INTEROPERABLE_INTEGER,
            );
            expect(Math.abs(g.max), `${owner.name}.${name}`).toBeLessThanOrEqual(
              MAX_INTEROPERABLE_INTEGER,
            );
          }
  });

  it('declares the preservation feature of ADR 0017 (CDM-051)', () => {
    const node = (n: string) => CDM1.nodes.find((x) => x.name === n)!;
    const block = node('preserved_block');
    expect(block).toMatchObject({ atom: true, feature: 'preserve' });
    expect(block.group!.split(' ')).toEqual(
      expect.arrayContaining(['block', 'story_block', 'cell_block']),
    );
    expect(node('preserved_inline')).toMatchObject({
      atom: true,
      inline: true,
      feature: 'preserve',
    });
    expect(CDM1.marks.find((m) => m.name === 'preserved')).toMatchObject({ feature: 'preserve' });
    // The core attribute `preserved` on block and definition nodes: null by default, non-null only
    // with the feature. Host extensions and the nodes of 12 (roles, rules) come from no Word file.
    const blockLevel = CDM1.nodes.filter(
      (n) =>
        (n.group ?? '')
          .split(' ')
          .some((g) => ['block', 'story_block', 'cell_block'].includes(g)) ||
        ['region', 'section_break', 'story', 'table_row', 'table_cell'].includes(n.name),
    );
    const definitions = ['settings', 'style_def', 'numbering_def', 'page_setup'].map(node);
    const without = new Set(['extension_block', 'preserved_block']);
    for (const n of [...blockLevel, ...definitions]) {
      if (without.has(n.name)) continue;
      expect(n.attrs['preserved'], n.name).toMatchObject({ default: null, feature: 'preserve' });
      expect(n.attrs['preserved']!.grammar).toMatchObject({
        kind: 'elementTree',
        maxDepth: 12,
        maxBytes: n.name === 'style_def' ? 32768 : 16384,
      });
    }
  });
});
