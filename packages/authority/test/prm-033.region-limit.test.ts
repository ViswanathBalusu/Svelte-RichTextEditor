// PRM-033 criterion 3, the server half (lane U-PRM-018-034): a document may hold at most 500
// regions (I7, `too_many_regions` in the model's validator). A commit that adds the 501st region is
// refused with `invalid_op` and nothing is stored; a commit that reaches exactly 500 is accepted.
// The editor's explanation of the limit is the shell's and is not claimed here.
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { checkInvariants } from '../src/invariants.ts';
import { applySteps } from '../src/rebase.ts';
import { BASE_JSON, REQUIRES, posOf, schema } from './fixtures.ts';

type J = Record<string, unknown>;

const LIMIT = 500;
const BASE_REGIONS = 3;
const END = 'pEnd00000000001Z';

/** A region of the base document's body, with a fresh 16-character identifier per number. */
function generatedRegion(n: number): J {
  const pad = String(n).padStart(12, '0');
  return {
    type: 'region',
    attrs: { id: `rGen${pad}`, title: `Generated ${n}`, policy: 'inherit' },
    content: [
      { type: 'paragraph', attrs: { id: `pGen${pad}` }, content: [{ type: 'text', text: 'x' }] },
    ],
  };
}

/** The base document with `total` regions in its body, checked by the schema. */
function withRegions(total: number): Node {
  const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
  const body = json.content[1]!.content;
  const end = body.findIndex((b) => (b['attrs'] as J | undefined)?.['id'] === END);
  const generated = Array.from({ length: total - BASE_REGIONS }, (_, i) => generatedRegion(i + 1));
  body.splice(end, 0, ...generated);
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

/** One more region before the document's last paragraph, as a commit would insert it. */
function addRegion(doc: Node): { steps: Step[]; after: Node; docs: Node[] } {
  const pos = posOf(doc, END);
  const region = schema.nodeFromJSON(generatedRegion(9_999));
  const steps: Step[] = [new ReplaceStep(pos, pos, new Slice(Fragment.from(region), 0, 0))];
  const r = applySteps(doc, steps);
  if (!r.ok) throw new Error(r.reason);
  return { steps, after: r.value.doc, docs: r.value.docs as Node[] };
}

const ctx = { requires: REQUIRES, retiredRegionIds: new Set<string>() };

describe('the region limit of 500 (PRM-033 criterion 3, server half)', () => {
  it('accepts a commit that reaches exactly the limit', () => {
    const before = withRegions(LIMIT - 1);
    const { steps, after, docs } = addRegion(before);
    expect(after.child(after.childCount - 1).childCount).toBeGreaterThan(0);
    const inv = checkInvariants(before, after, steps, docs, ctx);
    expect(inv.ok).toBe(true);
  });

  it('refuses the 501st region with invalid_op and names the limit', () => {
    const before = withRegions(LIMIT);
    const { steps, after, docs } = addRegion(before);
    const inv = checkInvariants(before, after, steps, docs, ctx);
    expect(inv).toMatchObject({ ok: false, code: 'invalid_op' });
    expect((inv as { reason: string }).reason).toMatch(/regions/);
  });
});
