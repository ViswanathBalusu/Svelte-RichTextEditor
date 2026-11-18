// The generated ProseMirror schema (CDM-008).
import { describe, expect, it } from 'vitest';
import { Slice, Fragment } from 'prosemirror-model';
import { AddNodeMarkStep, AttrStep, ReplaceStep } from 'prosemirror-transform';
import example from '../../fixtures/example-03-12.json' with { type: 'json' };
import kitchenSink from '../../fixtures/kitchen-sink.json' with { type: 'json' };
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
