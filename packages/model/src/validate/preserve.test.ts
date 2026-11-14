// The model changes of spike S11 for lossless Word files (CDM-051; ADR 0017 "Changes from spike
// S11"): marks on inline atoms, an origin for inline atoms, the grammar of element trees (depth,
// sizes, registered prefixes), shared trees in `preserved_def`, and small markers in
// `preserved_inline`.
import { describe, expect, it } from 'vitest';
import {
  addDefs,
  bodyOf,
  codes,
  ctx,
  exampleDoc,
  invariants,
  text,
  type Json,
} from '../../test/support.ts';
import { canonicalNode, type JsonNode } from '../canonical/canonical-form.ts';
import { CDM1 } from '../definition/cdm1.ts';
import { cdmSchema } from '../prosemirror/index.ts';
import { validate } from './validate.ts';

const ASSET = '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10';
const HASH = '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae';
const image = (attrs: Json = {}, marks?: Json[]): Json => ({
  type: 'image',
  attrs: { asset: ASSET, width: 480, height: 480, ...attrs },
  ...(marks ? { marks } : {}),
});
const preserveDoc = (): Json => {
  const d = exampleDoc();
  d['requires'] = ['preserve'];
  return d;
};

describe('marks on inline atoms (spike S11, change 1)', () => {
  it('lets an inline atom carry formatting and suggestion marks, as text does', () => {
    const d = exampleDoc();
    bodyOf(d)[2]!.content = [
      text('Logo '),
      image({}, [
        { type: 'bold' },
        { type: 'ins', attrs: { id: 'sImageInsert0001', user: 'alice' } },
      ]),
      { type: 'equation', attrs: { latex: 'x' }, marks: [{ type: 'italic' }] },
    ];
    expect(validate(d, ctx).violations).toEqual([]);
    const pm = cdmSchema().nodeFromJSON(d['doc']);
    pm.check();
    expect(canonicalNode(pm.toJSON() as JsonNode)).toEqual(canonicalNode(d['doc'] as JsonNode));
  });

  it('checks those marks like text marks, and keeps node marks for blocks', () => {
    const d = exampleDoc();
    bodyOf(d)[2]!.content = [image({}, [{ type: 'color', attrs: { value: 'red' } }])];
    expect(codes(d)).toEqual(['attribute_invalid']);
    const fmt = exampleDoc();
    bodyOf(fmt)[2]!.content = [
      image({}, [
        {
          type: 'fmt',
          attrs: { id: 'sFmt000000000001', user: 'carol', before: { attrs: { width: 100 } } },
        },
      ]),
    ];
    expect(codes(fmt)).toEqual(['fmt_before']);
    const figure = exampleDoc();
    bodyOf(figure).push({
      type: 'figure',
      attrs: { id: 'fgFigure00000001', asset: ASSET, width: 10, height: 10 },
      marks: [{ type: 'bold' }],
    });
    expect(codes(figure)).toContain('node_mark_host');
  });
});

describe('an origin for inline atoms (spike S11, change 2; SR-M10)', () => {
  it('gives image, equation, field, footnote, anchor and citation an origin of fragment and hash', () => {
    for (const name of ['image', 'equation', 'field', 'footnote', 'anchor', 'citation']) {
      const a = CDM1.nodes.find((n) => n.name === name)!.attrs['origin'];
      expect(a, name).toMatchObject({ default: null, feature: 'preserve' });
    }
    const d = preserveDoc();
    bodyOf(d)[2]!.content = [image({ origin: { fragment: ASSET, hash: HASH } })];
    expect(validate(d, ctx).violations).toEqual([]);
  });

  it('needs `preserve`, an attached fragment (I4) and a SHA-256 hash (I11)', () => {
    const noFeature = exampleDoc();
    bodyOf(noFeature)[2]!.content = [image({ origin: { fragment: ASSET, hash: HASH } })];
    expect(codes(noFeature)).toEqual(['feature_missing']);
    const unattached = preserveDoc();
    bodyOf(unattached)[2]!.content = [
      image({ origin: { fragment: '0192f0c4-7b1e-7c3a-9a54-0000000000cc', hash: HASH } }),
    ];
    expect(codes(unattached)).toEqual(['asset_not_attached']);
    const badHash = preserveDoc();
    bodyOf(badHash)[2]!.content = [image({ origin: { fragment: ASSET, hash: 'abc' } })];
    expect(codes(badHash)).toEqual(['attribute_invalid']);
  });
});

describe('shared trees in preserved_def (spike S11, change 4)', () => {
  const shared = (id = 'pdShared', tree: Json = { children: [{ name: 'w:keepLines' }] }): Json => ({
    type: 'preserved_def',
    attrs: { id, tree },
  });

  it('lets nodes and marks refer to one tree kept once in defs', () => {
    const d = addDefs(preserveDoc(), shared());
    expect(defsOf(d).at(-1)!.type).toBe('preserved_def');
    bodyOf(d)[2]!.attrs.preserved = { ref: 'pdShared' };
    bodyOf(d)[0]!.content[0].marks = [{ type: 'preserved', attrs: { props: { ref: 'pdShared' } } }];
    expect(validate(d, ctx).violations).toEqual([]);
  });

  it('refuses a reference to a tree that does not exist, and deleting a tree still referred to (I4)', () => {
    const d = preserveDoc();
    bodyOf(d)[2]!.attrs.preserved = { ref: 'pdMissing' };
    expect(codes(d)).toEqual(['unresolved_reference']);
  });

  it('keeps a shared tree a tree: it never refers to another (I11)', () => {
    const d = addDefs(preserveDoc(), shared('pdA', { ref: 'pdB' }), shared('pdB'));
    expect(invariants(d)).toEqual(['I11']);
  });

  it('allows 32 KiB of tree on a style and 16 KiB elsewhere, 12 levels deep', () => {
    const big = { children: [{ name: 'w:t', children: [{ text: 'x'.repeat(20000) }] }] };
    const style = exampleDoc();
    style['requires'] = ['preserve'];
    style['doc'].content[0].content[1].attrs.preserved = big;
    expect(invariants(style)).toEqual([]);
    const para = preserveDoc();
    bodyOf(para)[2]!.attrs.preserved = big;
    expect(invariants(para)).toEqual(['I11']);
  });
});

describe('small markers in preserved_inline (spike S11, change 7)', () => {
  it('holds either a fragment asset or the tree of a marker without relationships', () => {
    const marker = (attrs: Json): Json => ({
      type: 'preserved_inline',
      attrs: { label: 'bookmark', ...attrs },
    });
    const tree = preserveDoc();
    bodyOf(tree)[2]!.content = [marker({ tree: { attrs: { 'w:name': '_GoBack' } } })];
    expect(validate(tree, ctx).violations).toEqual([]);
    const neither = preserveDoc();
    bodyOf(neither)[2]!.content = [marker({})];
    expect(codes(neither)).toEqual(['preserved_without_payload']);
  });
});

const defsOf = (d: Json): Json[] => d['doc'].content[0].content;
