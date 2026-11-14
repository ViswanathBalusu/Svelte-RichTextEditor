// Unit properties of projections (ADR 0019; S12).
import fc from 'fast-check';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import {
  type HiddenSet,
  diffStep,
  fullToProj,
  project,
  projToFull,
  projectionSchema,
  toFullSteps,
} from '../src/projection/projection.ts';
import { schema } from './fixtures.ts';
import { INCOME, LEGAL, SECRET_REGION, SECRET_VALUE, secretDoc } from './harness/projection-sim.ts';

const hidden: HiddenSet = { regions: new Set([LEGAL]), values: new Set([INCOME]), titles: false };
const pschema = projectionSchema();

function textPositions(doc: ReturnType<typeof secretDoc>): number[] {
  const out: number[] = [];
  doc.descendants((n, pos) => {
    if (n.isTextblock) for (let i = 0; i <= n.content.size; i++) out.push(pos + 1 + i);
    return true;
  });
  return out;
}

describe('projection', () => {
  it('hides the region and the value and leaves the full document untouched', () => {
    const full = secretDoc();
    const before = JSON.stringify(full.toJSON());
    const p = project(full, hidden, pschema);
    const text = JSON.stringify(p.doc.toJSON());
    expect(text).not.toContain(SECRET_REGION);
    expect(text).not.toContain(SECRET_VALUE);
    expect(text).toContain('hidden_region');
    expect(JSON.stringify(full.toJSON())).toBe(before);
  });

  it('maps positions around a hidden region in both directions', () => {
    const full = secretDoc();
    const p = project(full, hidden, pschema);
    const span = p.spans[0]!;
    expect(fullToProj(p, span.fullStart)).toBe(span.projStart);
    expect(fullToProj(p, span.fullStart + 1)).toBeNull();
    expect(fullToProj(p, span.fullStart + span.fullSize)).toBe(span.projStart + 1);
    expect(projToFull(p, span.projStart)).toBe(span.fullStart);
    expect(projToFull(p, span.projStart + 1)).toBe(span.fullStart + span.fullSize);
  });

  it('builds a diff step that turns one projection into the next', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            at: fc.nat(10_000),
            len: fc.nat(6),
            kind: fc.nat(3),
            text: fc.string({ minLength: 1, maxLength: 3, unit: fc.constantFrom('x', 'y') }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (ops) => {
          const full = secretDoc();
          const tr = new Transform(full);
          for (const op of ops) {
            const positions = textPositions(tr.doc);
            const from = positions[op.at % positions.length]!;
            const end = tr.doc.resolve(from).end();
            const to = Math.min(end, from + op.len);
            try {
              if (op.kind === 0) tr.insert(from, schema.text(op.text));
              else if (op.kind === 1 && to > from) tr.delete(from, to);
              else if (op.kind === 2 && to > from)
                tr.addMark(from, to, schema.marks['bold']!.create());
              else tr.split(from);
            } catch {
              /* skip inapplicable edits */
            }
          }
          const a = project(full, hidden, pschema).doc;
          const b = project(tr.doc, hidden, pschema).doc;
          // The incremental projection (which reuses unchanged nodes) equals one built from scratch.
          expect(b.eq(project(schema.nodeFromJSON(tr.doc.toJSON()), hidden, pschema).doc)).toBe(
            true,
          );
          const d = diffStep(a, b);
          if (!d) {
            // Only hidden content changed: the projections are equal.
            expect(a.eq(b)).toBe(true);
            return;
          }
          const r = d.apply(a);
          expect(r.failed, r.failed ?? '').toBeNull();
          expect(r.doc!.eq(b)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("refuses a reader's step that touches the placeholder or sets a hidden value", () => {
    const full = secretDoc();
    const p = project(full, hidden, pschema);
    const span = p.spans[0]!;
    const del = new Transform(p.doc).delete(span.projStart, span.projStart + 1).steps;
    expect(toFullSteps(del, full, hidden, pschema, schema).ok).toBe(false);
    let fieldPos = -1;
    p.doc.descendants((n, pos) => {
      if (n.type.name === 'form_field' && n.attrs['id'] === INCOME) fieldPos = pos;
      return true;
    });
    const set = new Transform(p.doc).setNodeAttribute(fieldPos, 'value', 'guess').steps;
    expect(toFullSteps(set, full, hidden, pschema, schema).ok).toBe(false);
    // Typing after the hidden region maps across it.
    const after = span.projStart + 2;
    const type = new Transform(p.doc).insert(after, pschema.text('ok')).steps;
    const r = toFullSteps(type, full, hidden, pschema, schema);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(
        project(r.value.doc, hidden, pschema).doc.eq(
          new Transform(p.doc).insert(after, pschema.text('ok')).doc,
        ),
      ).toBe(true);
  });
});
