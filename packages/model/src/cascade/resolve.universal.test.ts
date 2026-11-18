// The formatting cascade (CDM-041; 03 §6; ADR 0032): what the shared fixtures cannot show on
// their own. Styles change without any paragraph changing; nothing writes into the document; the
// property lists match the definition; broken chains are typed errors in runs too.
import { describe, expect, it } from 'vitest';
import example from '../../fixtures/example-03-12.json' with { type: 'json' };
import { CDM1 } from '../definition/cdm1.ts';
import { checkGrammar } from '../validate/index.ts';
import {
  BASE_PARAGRAPH,
  BASE_RUN,
  PARAGRAPH_PROPERTIES,
  RUN_PROPERTIES,
  resolveParagraph,
  resolveRun,
  sortTabs,
} from './resolve.ts';
import { type TreeNode, styleChain, styleTable } from './styles.ts';

type J = Record<string, unknown>;

function docWith(styles: J[]): TreeNode {
  const env = structuredClone(example) as unknown as { doc: { content: { content: J[] }[] } };
  env.doc.content[0]!.content.splice(
    3,
    0,
    ...styles.map((attrs) => ({ type: 'style_def', attrs })),
  );
  return env.doc as unknown as TreeNode;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function resolved(doc: TreeNode, attrs: J) {
  const r = resolveParagraph(styleTable(doc), attrs);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe('the cascade (CDM-041)', () => {
  it('shows a changed style definition on the next resolution, although no paragraph changed', () => {
    const before = docWith([{ id: 'Body', kind: 'paragraph', name: 'Body', basedOn: 'Normal' }]);
    const paragraph = { id: 'pA1b2C3d4E5f6G7h', style: 'Body' };
    expect(resolved(before, paragraph).properties.spaceAfter).toBe(160); // from Normal, through basedOn
    // An attr step on Normal's spaceAfter: a new document, a new table, the same paragraph.
    const after = structuredClone(before) as unknown as { content: { content: J[] }[] };
    (after.content[0]!.content[1]!['attrs'] as J)['spaceAfter'] = 240;
    expect(resolved(after as unknown as TreeNode, paragraph).properties.spaceAfter).toBe(240);
    expect(resolved(before, paragraph).properties.spaceAfter).toBe(160);
  });

  it('writes nothing into the document: resolving a frozen document leaves it as it was', () => {
    const doc = deepFreeze(docWith([{ id: 'Body', kind: 'paragraph', name: 'Body', bold: true }]));
    const text = JSON.stringify(doc);
    const table = styleTable(doc);
    const p = resolveParagraph(table, Object.freeze({ style: 'Body', spaceBefore: 20 }), {
      trace: true,
    });
    expect(p.ok).toBe(true);
    if (p.ok) {
      const run = resolveRun(table, p.value, [{ type: 'italic' }]);
      expect(run.ok && run.value.italic && run.value.bold).toBe(true);
      expect(Object.isFrozen(p.value.properties)).toBe(true);
    }
    expect(JSON.stringify(doc)).toBe(text);
  });

  it('returns the same result for the same input, and shares it between plain paragraphs', () => {
    const table = styleTable(docWith([]));
    const a = resolveParagraph(table, { style: 'Heading1' });
    const b = resolveParagraph(table, { style: 'Heading1', id: 'p3Jq8sLw0aZx1VbN' });
    expect(a).toEqual(b);
    expect(a.ok && b.ok && a.value === b.value).toBe(true);
  });

  it('reports a broken character style chain as a typed error, and ends', () => {
    const doc = docWith([
      { id: 'A', kind: 'character', name: 'A', basedOn: 'B' },
      { id: 'B', kind: 'character', name: 'B', basedOn: 'A' },
    ]);
    const table = styleTable(doc);
    const p = resolveParagraph(table, {});
    if (!p.ok) throw new Error(p.error.message);
    const run = resolveRun(table, p.value, [{ type: 'charStyle', attrs: { style: 'A' } }]);
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error.code).toBe('style_cycle');
      expect(run.error.chain).toEqual(['A', 'B']);
    }
    const missing = resolveRun(table, p.value, [{ type: 'charStyle', attrs: { style: 'Nope' } }]);
    expect(!missing.ok && missing.error.code).toBe('style_missing');
  });

  it('follows ten styles and refuses the eleventh (I5), from the root to the style', () => {
    const chain = Array.from({ length: 11 }, (_, i) => ({
      id: `s${i}`,
      kind: 'paragraph',
      name: `S${i}`,
      ...(i ? { basedOn: `s${i - 1}` } : {}),
    }));
    const table = styleTable(docWith(chain));
    const ten = styleChain(table, 's9');
    expect(ten.ok && ten.chain).toEqual(chain.slice(0, 10).map((s) => s.id));
    const eleven = styleChain(table, 's10');
    expect(!eleven.ok && eleven.error.code).toBe('style_chain_too_long');
  });

  it('keeps the property lists equal to the formatting attributes of the definition (03 §4.5)', () => {
    const attrs = (name: string): string[] =>
      Object.keys(CDM1.nodes.find((n) => n.name === name)!.attrs);
    const structural = new Set([
      'id',
      'style',
      'numbering',
      'numberingRestart',
      'suggest',
      'preserved',
      'ext',
    ]);
    expect(
      attrs('paragraph')
        .filter((a) => !structural.has(a))
        .sort(),
    ).toEqual([...PARAGRAPH_PROPERTIES].sort());
    const styleOnly = new Set([
      ...structural,
      'kind',
      'name',
      'basedOn',
      'next',
      'outlineLevel',
      'builtIn',
      'cellMargins',
      'headerRowShading',
      'bandedRows',
    ]);
    expect(
      attrs('style_def')
        .filter((a) => !styleOnly.has(a))
        .sort(),
    ).toEqual([...PARAGRAPH_PROPERTIES, ...RUN_PROPERTIES].sort());
  });

  it('uses base values that the attribute grammars accept', () => {
    const style = CDM1.nodes.find((n) => n.name === 'style_def')!.attrs;
    const base = { ...BASE_PARAGRAPH, ...BASE_RUN } as Record<string, unknown>;
    for (const [k, v] of Object.entries(base))
      expect(checkGrammar(style[k]!.grammar, v, k), k).toEqual([]);
  });

  it('sorts tab stops by position and keeps the last of two at one position', () => {
    expect(
      sortTabs([
        { position: 3000, align: 'left', leader: 'none' },
        { position: 1000, align: 'left', leader: 'none' },
        { position: 3000, align: 'right', leader: 'dot' },
      ]),
    ).toEqual([
      { position: 1000, align: 'left', leader: 'none' },
      { position: 3000, align: 'right', leader: 'dot' },
    ]);
  });

  it('reads ProseMirror-shaped nodes as well as JSON (type.name, content.forEach)', () => {
    const json = docWith([]) as unknown as { type: string; content: J[] };
    const pmLike = (n: J): TreeNode => ({
      type: { name: n['type'] as string },
      attrs: (n['attrs'] as J | undefined) ?? {},
      content: {
        forEach: (f: (child: TreeNode) => void) =>
          ((n['content'] as J[] | undefined) ?? []).forEach((c) => f(pmLike(c))),
      },
    });
    const a = styleTable(json as unknown as TreeNode);
    const b = styleTable(pmLike(json as unknown as J));
    expect([...b.styles.keys()]).toEqual([...a.styles.keys()]);
    expect(b.settings).toEqual(a.settings);
  });
});
