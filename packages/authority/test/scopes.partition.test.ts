// The partition of a document into permission scopes (07 §5.1; PRM-008, criterion 1): over
// generated documents every node belongs to exactly one scope and every form field's value to its
// own, and changing any one node changes exactly the scope the partition assigns it to, both for
// the identity-pruned diff and for the oracle's serialised comparison.
import fc from 'fast-check';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { AddMarkStep, AttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { diffScopes, partitionScopes } from '../src/permissions/scopes.ts';
import { applySteps } from '../src/rebase.ts';
import { baseDoc, schema } from './fixtures.ts';
import { changedScopes } from './harness/oracle.ts';
import { fieldsDoc } from './permission-fixtures.ts';

type J = Record<string, unknown>;

const text = fc.string({ minLength: 0, maxLength: 6, unit: fc.constantFrom('a', 'b', ' ', 'ü') });
const para = fc.record({
  text,
  bold: fc.boolean(),
  field: fc.option(fc.constantFrom('text', 'number', 'signature'), { nil: null }),
  value: fc.boolean(),
  sensitive: fc.boolean(),
});
type Para = {
  text: string;
  bold: boolean;
  field: string | null;
  value: boolean;
  sensitive: boolean;
};
const block = fc.oneof(
  { weight: 5, arbitrary: para.map((p) => ({ k: 'p' as const, p })) },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant('region' as const),
      ps: fc.array(para, { minLength: 1, maxLength: 3 }),
      policy: fc.constantFrom('inherit', 'restricted'),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ k: 'sb' as const }) },
);
const shape = fc.record({
  blocks: fc.array(block, { minLength: 1, maxLength: 8 }),
  stories: fc.array(fc.array(para, { minLength: 1, maxLength: 2 }), { maxLength: 2 }),
  styles: fc.nat(2),
});

/** A valid CDM document of the given shape; identifiers are unique by construction. */
type Shape = typeof shape extends fc.Arbitrary<infer T> ? T : never;

function build(s: Shape): Node {
  let n = 0;
  const id = (prefix: string) => `${prefix}${String(++n).padStart(15, '0')}`;
  const paragraph = (p: Para): J => {
    const content: J[] = [];
    if (p.text)
      content.push({
        type: 'text',
        text: p.text,
        ...(p.bold ? { marks: [{ type: 'bold' }] } : {}),
      });
    if (p.field)
      content.push({
        type: 'form_field',
        attrs: {
          id: id('f'),
          key: `k${n}`,
          kind: p.field,
          label: 'Field',
          assignee: 'role_tenant',
          sensitive: p.sensitive,
          value: p.value && p.field !== 'signature' ? (p.field === 'number' ? '1' : 'v') : null,
        },
      });
    return { type: 'paragraph', attrs: { id: id('p') }, content };
  };
  const styles: J[] = [
    { type: 'style_def', attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal' } },
  ];
  for (let i = 0; i < s.styles; i++)
    styles.push({
      type: 'style_def',
      attrs: { id: `S${i}`, kind: 'paragraph', name: `S${i}`, basedOn: 'Normal' },
    });
  const body: J[] = s.blocks.map((b) =>
    b.k === 'p'
      ? paragraph(b.p)
      : b.k === 'sb'
        ? { type: 'section_break', attrs: { id: id('b'), pageSetup: 'ps1' } }
        : {
            type: 'region',
            attrs: { id: id('r'), policy: b.policy, title: 'T' },
            content: b.ps.map(paragraph),
          },
  );
  const json = {
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [
          { type: 'settings', attrs: { lang: 'en-GB' } },
          ...styles,
          { type: 'page_setup', attrs: { id: 'ps1' } },
          { type: 'role_def', attrs: { id: 'role_tenant', name: 'Tenant', color: '#1F77B4' } },
        ],
      },
      ...s.stories.map((ps, i) => ({
        type: 'story',
        attrs: { id: id('s'), kind: i % 2 ? 'footer' : 'header' },
        content: ps.map(paragraph),
      })),
      { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
    ],
  };
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

/** Every node position of a document (the root is -1). */
function positions(doc: Node): Array<{ pos: number; node: Node }> {
  const out: Array<{ pos: number; node: Node }> = [{ pos: -1, node: doc }];
  doc.descendants((node, pos) => {
    out.push({ pos, node });
    return true;
  });
  return out;
}

/** A change to exactly one node: its `ext`, its text, a mark, or a field's value. */
function mutate(
  doc: Node,
  pos: number,
  node: Node,
  variant: number,
): { after: Node; value: boolean } | null {
  if (pos === -1)
    return {
      after: doc.type.create({ ...doc.attrs, ext: { mutated: true } }, doc.content),
      value: false,
    };
  let steps: Step[];
  if (node.isText) {
    const other = node.text?.[0] === 'z' ? 'y' : 'z';
    steps =
      variant % 2
        ? [new AddMarkStep(pos, pos + 1, schema.marks['italic']!.create())]
        : [
            new ReplaceStep(
              pos,
              pos + 1,
              new Slice(Fragment.from(schema.text(other, node.marks)), 0, 0),
            ),
          ];
  } else if (node.type.name === 'form_field' && variant % 2) {
    steps = [new AttrStep(pos, 'value', node.attrs['kind'] === 'number' ? '42' : 'changed')];
    const r = applySteps(doc, steps);
    return r.ok ? { after: r.value.doc, value: true } : null;
  } else if (node.type.spec.attrs?.['ext'])
    steps = [new AttrStep(pos, 'ext', { mutated: variant })];
  else return null;
  const r = applySteps(doc, steps);
  return r.ok ? { after: r.value.doc, value: false } : null;
}

describe('the partition of a document into scopes (PRM-008)', () => {
  it('assigns every node to exactly one scope and every value to its own (property test)', () => {
    let nodes = 0;
    let mutations = 0;
    const seen = new Set<string>();
    fc.assert(
      fc.property(shape, fc.nat(10_000), fc.nat(3), (s, pick, variant) => {
        const doc = build(s);
        const part = partitionScopes(doc);
        const all = positions(doc);
        // Total and disjoint: one scope per node position, and no other positions.
        expect([...part.nodes.keys()].sort((a, b) => a - b)).toEqual(all.map((p) => p.pos));
        nodes += all.length;
        // Every value of a form field has its own scope.
        const fields = all.filter((p) => p.node.type.name === 'form_field');
        expect([...part.values.keys()].sort()).toEqual(
          fields.map((f) => String(f.node.attrs['id'])).sort(),
        );
        for (const [id, scope] of part.values) expect(scope).toBe(`field:${id}`);
        // Each scope names what it holds.
        for (const { pos, node } of all) {
          const scope = part.nodes.get(pos)!;
          seen.add(scope.split(':')[0]!);
          if (node.type.name === 'region') expect(scope).toBe(`region:${String(node.attrs['id'])}`);
          if (node.type.name === 'story') expect(scope).toBe(`story:${String(node.attrs['id'])}`);
          if (['doc', 'defs', 'body'].includes(node.type.name)) expect(scope).toBe('doc');
        }
        // Changing one node changes exactly its scope: for the diff and for the oracle.
        const target = all[pick % all.length]!;
        const m = mutate(doc, target.pos, target.node, variant);
        if (!m) return;
        mutations++;
        const expected = m.value
          ? [part.values.get(String(target.node.attrs['id']))!]
          : [part.nodes.get(target.pos)!];
        expect(
          diffScopes(doc, m.after).changed,
          `${target.node.type.name} at ${target.pos}`,
        ).toEqual(expected);
        expect(changedScopes(doc, m.after), `${target.node.type.name} at ${target.pos}`).toEqual(
          expected,
        );
      }),
      { numRuns: 600 },
    );
    expect(nodes).toBeGreaterThan(10_000);
    expect(mutations).toBeGreaterThan(400);
    expect([...seen].sort()).toEqual(['body', 'defs', 'doc', 'region', 'story']);
  });

  it('partitions the fixture documents, where field values sit in the body and in regions', () => {
    for (const doc of [baseDoc(), fieldsDoc()]) {
      const part = partitionScopes(doc);
      expect(part.nodes.size).toBe(positions(doc).length);
      let fieldsSeen = 0;
      doc.descendants((n, pos) => {
        if (n.type.name !== 'form_field') return true;
        fieldsSeen++;
        const id = String(n.attrs['id']);
        expect(part.values.get(id)).toBe(`field:${id}`);
        // The field node itself belongs to its container, not to its value's scope.
        expect(part.nodes.get(pos)).not.toBe(`field:${id}`);
        return false;
      });
      expect(fieldsSeen).toBeGreaterThan(0);
    }
  });
});
