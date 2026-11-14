// The authority's invariant check and the CDM's model.validate() report the same violations on the
// shared corpus (SYN-011; FND-006): on the documents as published and after commits that break them.
import { loadDocument } from '@docedit/corpus';
import { cdmSchema } from '@docedit/model/prosemirror';
import { validate } from '@docedit/model/validate';
import type { Node } from 'prosemirror-model';
import { AddMarkStep, AttrStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { checkInvariants } from '../src/invariants.ts';
import { applySteps } from '../src/rebase.ts';

const schema = cdmSchema();

function first(doc: Node, type: string): { node: Node; pos: number } {
  let found: { node: Node; pos: number } | null = null;
  doc.child(doc.childCount - 1).descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === type)
      found = { node, pos: doc.content.size - doc.child(doc.childCount - 1).nodeSize + 1 + pos };
    return !found;
  });
  if (!found) throw new Error(`no ${type}`);
  return found;
}

function styleAt(doc: Node): number {
  let pos = -1;
  doc.child(0).forEach((n, offset) => {
    if (pos < 0 && n.type.name === 'style_def') pos = 1 + offset;
  });
  return pos;
}

/** Commits that break an invariant without touching an identifier. */
const breakers: Array<[string, (doc: Node) => Step[]]> = [
  [
    'a style that does not exist (I4)',
    (doc) => [new AttrStep(first(doc, 'paragraph').pos, 'style', 'Missing')],
  ],
  ['a colour in lower case (I11)', (doc) => [new AttrStep(styleAt(doc), 'color', '#abcdef')]],
  [
    'a link scheme that is not allowed (I9, as I11)',
    (doc) => {
      const p = first(doc, 'paragraph');
      return [
        new AddMarkStep(
          p.pos + 1,
          p.pos + 1 + Math.min(4, p.node.content.size),
          schema.marks['link']!.create({ href: 'javascript:x' }),
        ),
      ];
    },
  ],
];

describe('checkInvariants and model.validate() agree on the shared corpus (SYN-011)', () => {
  for (const name of ['pages-1', 'form-fields', 'pages-20'])
    it(`agrees on ${name} and on commits that break it`, async () => {
      const { envelope, attachedAssets } = await loadDocument(name);
      const requires = [...envelope.requires];
      const ctx = { requires, retiredRegionIds: new Set<string>(), attachedAssets };
      const doc = schema.nodeFromJSON(envelope.doc);
      expect(validate(envelope, ctx).violations, name).toEqual([]);
      expect(checkInvariants(doc, doc, [], [], ctx).ok, name).toBe(true);
      for (const [what, make] of breakers) {
        const steps = make(doc);
        const r = applySteps(doc, steps);
        if (!r.ok) throw new Error(`${name}, ${what}: ${r.reason}`);
        const violations = validate(
          { cdm: envelope.cdm, requires, doc: r.value.doc.toJSON() },
          ctx,
        ).violations;
        const verdict = checkInvariants(doc, r.value.doc, steps, r.value.docs, ctx);
        expect(violations.length, `${name}, ${what}`).toBeGreaterThan(0);
        expect(verdict.ok, `${name}, ${what}`).toBe(false);
        if (!verdict.ok) {
          const v = violations[0]!;
          expect(
            verdict.reason.startsWith(`${v.invariant} ${v.path}: ${v.message}`),
            `${name}, ${what}`,
          ).toBe(true);
        }
      }
    });
});
