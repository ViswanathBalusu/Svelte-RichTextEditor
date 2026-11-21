// The generated ProseMirror schema (CDM-008).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Slice, Fragment, type Mark, type Node as PmNode } from 'prosemirror-model';
import { AddNodeMarkStep, AttrStep, RemoveNodeMarkStep, ReplaceStep } from 'prosemirror-transform';
import example from '../../fixtures/example-03-12.json' with { type: 'json' };
import kitchenSink from '../../fixtures/kitchen-sink.json' with { type: 'json' };
import { codes, sinkCtx, sinkDoc, type Json } from '../../test/support.ts';
import { CDM1 } from '../definition/cdm1.ts';
import type { CdmDefinition, NodeDef } from '../definition/grammar.ts';
import { canonicalNode, type JsonNode } from '../canonical/canonical-form.ts';
import { schemaHash } from '../schema/artifacts.ts';
import { generateJsonSchema } from '../schema/json-schema.ts';
import { generateProseMirrorSpec } from '../schema/prosemirror-spec.ts';
import { cdmSchema } from './index.ts';

const schema = cdmSchema();

describe('CDM ProseMirror schema', () => {
  it('creates nodes with null identifiers without throwing (03 §9)', () => {
    const p = schema.nodes['paragraph']!.createAndFill();
    expect(p?.attrs['id']).toBeNull();
    const t = schema.nodes['table']!.createAndFill();
    expect(t).not.toBeNull();
    expect(t!.firstChild!.attrs['id']).toBeNull();
    const doc = schema.nodes['doc']!.createAndFill();
    expect(doc).not.toBeNull();
    expect(doc!.child(0).type.name).toBe('defs');
  });

  it('makes definitions and stories isolating, not selectable and closed to the gap cursor', () => {
    for (const name of ['defs', 'story']) {
      const spec = schema.nodes[name]!.spec;
      expect(spec.isolating).toBe(true);
      expect(spec.selectable).toBe(false);
      expect(spec['allowGapCursor']).toBe(false);
    }
    for (const name of [
      'settings',
      'style_def',
      'numbering_def',
      'page_setup',
      'role_def',
      'rule_def',
    ])
      expect(schema.nodes[name]!.spec.selectable).toBe(false);
    expect(schema.nodes['region']!.spec.isolating).toBe(true);
  });

  it('lets suggestion marks coexist, and keeps block suggestions in the `suggest` attribute', () => {
    const ins = schema.marks['ins']!;
    const a = ins.create({ id: 'sSuggestionAAAAA', user: 'u1' });
    const b = ins.create({ id: 'sSuggestionBBBBB', user: 'u2' });
    expect(b.addToSet(a.addToSet([]))).toHaveLength(2);
    expect(
      schema.marks['bold']!.create().addToSet([schema.marks['bold']!.create({ value: false })]),
    ).toHaveLength(1);

    const doc = schema.nodeFromJSON(example.doc);
    const bodyPos = doc.child(0).nodeSize; // position before body
    const firstParagraph = bodyPos + 1;
    // A block takes no node mark (owner decision 92): ProseMirror refuses it, and the step fails.
    expect(new AddNodeMarkStep(firstParagraph, a).apply(doc).failed).not.toBeNull();
    // Its suggestions are an attribute of a paragraph, a table row and a table.
    for (const name of ['paragraph', 'table_row', 'table'])
      expect(schema.nodes[name]!.spec.attrs?.['suggest'], name).toEqual({
        default: null,
        validate: expect.anything(),
      });
    const entry = { type: 'ins', attrs: { id: 'sSuggestionAAAAA', user: 'u1' } };
    const ok = new AttrStep(firstParagraph, 'suggest', [entry]).apply(doc);
    expect(ok.failed).toBeNull();
    ok.doc!.check();
    expect(ok.doc!.nodeAt(firstParagraph)!.attrs['suggest']).toEqual([entry]);
  });
  it('declares ext with default {} on every node and mark except text', () => {
    for (const [name, type] of Object.entries(schema.nodes)) {
      if (name === 'text') continue;
      expect(type.spec.attrs?.['ext'], name).toEqual({ default: {}, validate: 'object' });
    }
    for (const type of Object.values(schema.marks))
      expect(type.spec.attrs?.['ext']).toEqual({ default: {}, validate: 'object' });
  });

  it('reads the example and writes it back to the same canonical JSON', () => {
    const doc = schema.nodeFromJSON(example.doc);
    doc.check();
    expect(canonicalNode(doc.toJSON() as JsonNode)).toEqual(canonicalNode(example.doc as JsonNode));
  });

  it('applies a replace step against the schema', () => {
    const doc = schema.nodeFromJSON(example.doc);
    const pos = doc.child(0).nodeSize + 2; // inside the first paragraph of the body
    const step = new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('In ')), 0, 0));
    const r = step.apply(doc);
    expect(r.failed).toBeNull();
    expect(r.doc!.child(1).child(0).textContent).toBe('In Scope');
  });

  it('uses the footnote content model decided in CDM-001: paragraphs, not inline content', () => {
    expect(schema.nodes['footnote']!.spec.content).toBe('paragraph+');
    const fn = schema.nodes['footnote']!;
    const paragraph = schema.nodes['paragraph']!.create(
      { id: 'pFootnotePara001' },
      schema.text('note'),
    );
    expect(fn.validContent(Fragment.from(paragraph))).toBe(true);
    expect(fn.validContent(Fragment.from(schema.text('note')))).toBe(false);
    expect(fn.validContent(Fragment.empty)).toBe(false);
    // A paragraph admits any inline node, a footnote included; model.validate() refuses a footnote
    // inside a footnote and a second paragraph (I10, I1; validate.test.ts).
    const nested = fn.create({ id: 'fFootnote0000001' }, paragraph);
    const outer = schema.nodes['paragraph']!.create({ id: 'pFootnotePara002' }, nested);
    expect(fn.validContent(Fragment.from(outer))).toBe(true);
  });

  it('changes the schema hash when the mark order changes', async () => {
    const reordered = { ...CDM1, marks: [...CDM1.marks].reverse() };
    expect(await schemaHash(reordered)).not.toBe(await schemaHash(CDM1));
  });

  it('changes the schema hash with any node, mark, attribute or content expression (CDM-008)', async () => {
    const base = await schemaHash(CDM1);
    const mapNode = (name: string, f: (n: NodeDef) => NodeDef): CdmDefinition => ({
      ...CDM1,
      nodes: CDM1.nodes.map((n) => (n.name === name ? f(n) : n)),
    });
    const variants: Array<[string, CdmDefinition]> = [
      ['a node removed', { ...CDM1, nodes: CDM1.nodes.filter((n) => n.name !== 'toc') }],
      ['a mark removed', { ...CDM1, marks: CDM1.marks.filter((m) => m.name !== 'hidden') }],
      [
        'an attribute added',
        mapNode('paragraph', (n) => ({
          ...n,
          attrs: { ...n.attrs, extra: { grammar: { kind: 'boolean' }, default: false, doc: 'x' } },
        })),
      ],
      [
        'a default changed',
        mapNode('page_setup', (n) => ({
          ...n,
          attrs: { ...n.attrs, width: { ...n.attrs['width']!, default: 12240 } },
        })),
      ],
      [
        'a content expression changed',
        mapNode('footnote', (n) => ({ ...n, content: 'paragraph*' })),
      ],
    ];
    for (const [name, def] of variants) expect(await schemaHash(def), name).not.toBe(base);
  });

  it('creates every node type that declares an id with a null id (03 §9; CDM-008)', () => {
    for (const [name, type] of Object.entries(schema.nodes)) {
      if (!type.spec.attrs?.['id']) continue;
      expect(type.spec.attrs['id'], name).toMatchObject({ default: null });
      const node = type.createAndFill();
      expect(node, name).not.toBeNull();
      expect(node!.attrs['id'], name).toBeNull();
    }
  });

  it('reads the fixtures into ProseMirror and writes them back to the same canonical JSON', () => {
    for (const [name, env] of [
      ['example', example],
      ['kitchen sink', kitchenSink],
    ] as const) {
      const doc = schema.nodeFromJSON(env.doc);
      doc.check();
      expect(canonicalNode(doc.toJSON() as JsonNode), name).toEqual(
        canonicalNode(env.doc as JsonNode),
      );
    }
  });

  it('includes the preservation feature in both published schemas (CDM-051)', () => {
    const pm = generateProseMirrorSpec(CDM1);
    const names = pm.nodes.map(([n]) => n);
    expect(names).toEqual(expect.arrayContaining(['preserved_block', 'preserved_inline']));
    expect(pm.marks.map(([m]) => m)).toContain('preserved');
    expect(Object.fromEntries(pm.nodes)['paragraph']!.attrs!['preserved']).toEqual({
      default: null,
      validate: 'object|null',
    });
    const json = generateJsonSchema(CDM1)['$defs'] as Record<string, { description?: string }>;
    for (const key of ['node.preserved_block', 'node.preserved_inline', 'mark.preserved'])
      expect(json[key]?.description, key).toMatch(/Feature `preserve`/);
    // The preserved atoms survive a round trip through ProseMirror unchanged.
    const doc = schema.nodeFromJSON(kitchenSink.doc);
    const back = canonicalNode(doc.toJSON() as JsonNode);
    const text = JSON.stringify(back);
    for (const part of ['preserved_block', 'preserved_inline', '"preserved"', 'textAlignment'])
      expect(text).toContain(part);
  });
});

// CDM-008 criterion 4, as reworded on owner decisions 7 and 92 (docs/owner-decisions-2026-11-15.md):
// the suggestion marks exclude nothing; no block takes a mark, so the node-mark steps of 04 §4 apply
// to inline atoms only; and block suggestions are the `suggest` attribute of three node types.
describe('suggestions in the published schema (CDM-008 criterion 4)', () => {
  const SUGGESTION_MARKS = ['ins', 'del', 'fmt'] as const;
  const suggestion = (type: string, n: number): Mark =>
    schema.marks[type]!.create({
      id: `sSuggestion${String(n).padStart(5, '0')}`,
      user: `u${n}`,
      ...(type === 'fmt' ? { before: { marks: [] } } : {}),
    });
  const sink = (): PmNode => schema.nodeFromJSON(kitchenSink.doc);
  /** Every node of a document with its position, in document order. */
  const nodesOf = (doc: PmNode): Array<{ node: PmNode; pos: number }> => {
    const out: Array<{ node: PmNode; pos: number }> = [];
    doc.descendants((node, pos) => {
      out.push({ node, pos });
    });
    return out;
  };

  it('publishes ins, del and fmt as marks that exclude nothing, and no node that lets a block carry a mark', () => {
    const published = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../../../../spec/cdm/cdm-1.prosemirror.json'),
        'utf8',
      ),
    ) as {
      nodes: Array<[string, { marks?: string; attrs?: Record<string, unknown> }]>;
      marks: Array<[string, { excludes?: string }]>;
    };
    const marks = new Map(published.marks);
    for (const name of SUGGESTION_MARKS) expect(marks.get(name)?.excludes, name).toBe('');
    // Every other mark keeps ProseMirror's default: it excludes only another mark of its own type.
    for (const [name, spec] of published.marks)
      if (!(SUGGESTION_MARKS as readonly string[]).includes(name))
        expect(spec.excludes, name).toBeUndefined();
    // No node widens the marks of its children, so the default holds: only inline content takes marks.
    for (const [name, spec] of published.nodes) expect(spec.marks, name).toBeUndefined();
    expect(published).toEqual(JSON.parse(JSON.stringify(generateProseMirrorSpec(CDM1))));
  });

  it('lets each suggestion mark sit beside another of its type, beside the other two and beside formatting', () => {
    for (const type of SUGGESTION_MARKS) {
      const first = suggestion(type, 1);
      const second = suggestion(type, 2);
      expect(second.addToSet(first.addToSet([])), type).toHaveLength(2);
      // The same mark twice is one mark.
      expect(first.addToSet(first.addToSet([])), type).toHaveLength(1);
    }
    const all = [
      suggestion('ins', 1),
      suggestion('ins', 2),
      suggestion('del', 3),
      suggestion('fmt', 4),
      schema.marks['bold']!.create(),
    ];
    let set: readonly Mark[] = [];
    for (const m of all) set = m.addToSet(set);
    expect(set).toHaveLength(5);
    const paragraph = schema.nodes['paragraph']!.create(
      { id: 'pTwoSuggesters01' },
      schema.text('shared', set),
    );
    paragraph.check();
    expect(paragraph.firstChild!.marks.map((m) => m.type.name).sort()).toEqual([
      'bold',
      'del',
      'fmt',
      'ins',
      'ins',
    ]);
  });

  it('allows marks on the children of nodes with inline content only', () => {
    const withInline: string[] = [];
    for (const [name, type] of Object.entries(schema.nodes)) {
      if (type.inlineContent) {
        withInline.push(name);
        for (const mark of Object.values(schema.marks))
          expect(type.allowsMarkType(mark), `${name} ${mark.name}`).toBe(true);
      } else {
        for (const mark of Object.values(schema.marks))
          expect(type.allowsMarkType(mark), `${name} ${mark.name}`).toBe(false);
      }
    }
    expect(withInline.sort()).toEqual(['caption', 'paragraph']);
  });

  it('refuses addNodeMark on every block of the kitchen sink and applies it to every inline atom', () => {
    const doc = sink();
    const blocks = nodesOf(doc).filter(({ node }) => node.isBlock);
    const atoms = nodesOf(doc).filter(({ node }) => node.isInline && !node.isText);
    const blockTypes = new Set(blocks.map(({ node }) => node.type.name));
    for (const name of [
      'paragraph',
      'table',
      'table_row',
      'table_cell',
      'region',
      'figure',
      'caption',
      'story',
      'style_def',
      'section_break',
    ])
      expect(blockTypes.has(name), name).toBe(true);
    for (const type of SUGGESTION_MARKS) {
      const mark = suggestion(type, 1);
      for (const { node, pos } of blocks) {
        const added = new AddNodeMarkStep(pos, mark).apply(doc);
        expect(added.failed, `${type} on ${node.type.name} at ${pos}`).not.toBeNull();
        // Removing a mark a block cannot have changes nothing.
        const removed = new RemoveNodeMarkStep(pos, mark).apply(doc);
        expect(removed.failed).toBeNull();
        expect(removed.doc!.eq(doc), `${type} off ${node.type.name}`).toBe(true);
      }
    }
    const atomTypes = new Set(atoms.map(({ node }) => node.type.name));
    for (const name of ['image', 'field', 'footnote', 'equation', 'anchor'])
      expect(atomTypes.has(name), name).toBe(true);
    for (const type of SUGGESTION_MARKS) {
      const mark = suggestion(type, 1);
      for (const { node, pos } of atoms) {
        const added = new AddNodeMarkStep(pos, mark).apply(doc);
        expect(added.failed, `${type} on ${node.type.name} at ${pos}`).toBeNull();
        added.doc!.check();
        expect(mark.isInSet(added.doc!.nodeAt(pos)!.marks), node.type.name).toBe(true);
        const removed = new RemoveNodeMarkStep(pos, mark).apply(added.doc!);
        expect(removed.failed).toBeNull();
        expect(removed.doc!.eq(doc), `${type} off ${node.type.name}`).toBe(true);
      }
    }
  });

  it('keeps block suggestions in the suggest attribute of a paragraph, a table row and a table, and nowhere else', () => {
    const hosts = Object.entries(schema.nodes)
      .filter(([, type]) => type.spec.attrs?.['suggest'])
      .map(([name]) => name)
      .sort();
    expect(hosts).toEqual(['paragraph', 'table', 'table_row']);
    const doc = sink();
    const entry = { type: 'del', attrs: { id: 'sSuggestion00001', user: 'u1' } };
    for (const name of hosts) {
      expect(schema.nodes[name]!.spec.attrs!['suggest']!.default, name).toBeNull();
      const { pos } = nodesOf(doc).find(({ node }) => node.type.name === name)!;
      const set = new AttrStep(pos, 'suggest', [entry]).apply(doc);
      expect(set.failed, name).toBeNull();
      set.doc!.check();
      expect(set.doc!.nodeAt(pos)!.attrs['suggest'], name).toEqual([entry]);
    }
    // A node that is not a host has no such attribute, in ProseMirror or in a stored document.
    for (const name of ['table_cell', 'region', 'figure', 'equation_block', 'toc'])
      expect(schema.nodes[name]!.spec.attrs?.['suggest'], name).toBeUndefined();
  });

  it('has validate() refuse a mark on any block and a suggest attribute on any other node (I1)', () => {
    const mark = { type: 'ins', attrs: { id: 'sSuggestion00001', user: 'u1' } };
    const find = (node: Json, type: string): Json | undefined => {
      if (node['type'] === type) return node;
      for (const child of (node['content'] as Json[] | undefined) ?? []) {
        const found = find(child, type);
        if (found) return found;
      }
      return undefined;
    };
    expect(codes(sinkDoc(), sinkCtx)).toEqual([]);
    for (const type of ['paragraph', 'table', 'table_row', 'table_cell', 'region', 'figure']) {
      const d = sinkDoc();
      find(d['doc'], type)!['marks'] = [mark];
      expect(codes(d, sinkCtx), type).toContain('node_mark_host');
    }
    for (const type of ['table_cell', 'region', 'figure']) {
      const d = sinkDoc();
      find(d['doc'], type)!['attrs'].suggest = [mark];
      expect(codes(d, sinkCtx), type).toContain('unknown_attribute');
    }
    for (const type of ['paragraph', 'table', 'table_row']) {
      const d = sinkDoc();
      find(d['doc'], type)!['attrs'].suggest = [mark];
      expect(codes(d, sinkCtx), type).toEqual([]);
    }
  });
});
