/**
 * The counts of fill mode (FRW-076 criterion 2, FRW-078 criteria 1 and 4). The bar's "n of m" and
 * the summary's list come from one function, so the bar's remainder and the list agree whenever
 * every invalid field is a required one. A list that also holds an invalid optional field is the
 * open question recorded in docs/adr/0113-ui-backlog-batch.md.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { FillField, FillSummary } from '../src/core-api.ts';
import { fillProgress, fillReasonKey } from '../src/shell/fill.ts';

const INVALID = [null, 'format', 'range', 'required', 'other'] as const;

/** A field without its identifier; `summaryArb` names the fields in document order. */
const fieldArb = fc
  .record({
    required: fc.boolean(),
    filled: fc.boolean(),
    invalid: fc.constantFrom(...INVALID),
  })
  .map((f) => ({ ...f, invalid: f.filled ? f.invalid : null }));

const summaryArb = fc.array(fieldArb, { maxLength: 15 }).map((fields): FillSummary => ({
  active: true,
  fields: fields.map((f, i): FillField => ({ id: `f${i}`, label: `Field ${i}`, ...f })),
}));

/** Required fields that are filled and valid, the same way the bar counts them. */
function requiredDone(summary: FillSummary): number {
  return summary.fields.filter((f) => f.required && f.filled && f.invalid === null).length;
}

describe('the bar counts the required fields (FRW-076, criterion 2)', () => {
  it('counts filled, valid required fields out of all required fields (property)', () => {
    fc.assert(
      fc.property(summaryArb, (summary) => {
        const progress = fillProgress(summary);
        expect(progress.total).toBe(summary.fields.filter((f) => f.required).length);
        expect(progress.done).toBe(requiredDone(summary));
        expect(progress.done).toBeLessThanOrEqual(progress.total);
      }),
    );
  });

  it('moves to the first required field, in document order, that is empty or invalid', () => {
    fc.assert(
      fc.property(summaryArb, (summary) => {
        const progress = fillProgress(summary);
        const expected = summary.fields.find(
          (f) => f.required && (!f.filled || f.invalid !== null),
        );
        expect(progress.next).toEqual(expected ?? null);
      }),
    );
  });

  it('has no next field once every required field is filled and valid', () => {
    const done: FillSummary = {
      active: true,
      fields: [
        { id: 'a', label: 'A', required: true, filled: true, invalid: null },
        { id: 'b', label: 'B', required: false, filled: false, invalid: null },
      ],
    };
    expect(fillProgress(done)).toMatchObject({ done: 1, total: 1, next: null, left: [] });
  });
});

describe('fields that are not the participant’s (FRW-077, criteria 2 and 3)', () => {
  const summary: FillSummary = {
    active: true,
    roles: ['role_tenant'],
    fields: [
      {
        id: 'o1',
        label: 'Landlord name',
        required: true,
        filled: false,
        invalid: null,
        assignee: 'role_landlord',
      },
      {
        id: 'n1',
        label: 'Reference',
        required: true,
        filled: false,
        invalid: null,
        assignee: null,
      },
      {
        id: 'm1',
        label: 'Income',
        required: true,
        filled: false,
        invalid: null,
        assignee: 'role_tenant',
      },
      {
        id: 'm2',
        label: 'Phone',
        required: true,
        filled: true,
        invalid: 'format',
        assignee: 'role_tenant',
      },
    ],
  };

  it('counts, lists and moves only to the fields of the participant’s roles', () => {
    const progress = fillProgress(summary);
    expect(progress).toMatchObject({ done: 0, total: 2 });
    expect(progress.next?.id).toBe('m1');
    expect(progress.left.map((f) => f.id)).toEqual(['m1', 'm2']);
  });

  it('never leads to a field of another role or with no assignee (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            required: fc.boolean(),
            filled: fc.boolean(),
            invalid: fc.constantFrom(...INVALID),
            assignee: fc.constantFrom('role_a', 'role_b', null),
          }),
          { maxLength: 12 },
        ),
        (fields) => {
          const s: FillSummary = {
            active: true,
            roles: ['role_a'],
            fields: fields.map((f, i): FillField => ({ id: `f${i}`, label: `Field ${i}`, ...f })),
          };
          const progress = fillProgress(s);
          for (const f of [...progress.left, ...(progress.next ? [progress.next] : [])])
            expect(f.assignee).toBe('role_a');
          expect(progress.total).toBe(
            s.fields.filter((f) => f.required && f.assignee === 'role_a').length,
          );
        },
      ),
    );
  });
});

describe('the summary lists what is left (FRW-078, criteria 1 and 4)', () => {
  it('lists every required-and-empty field and every invalid field, in document order', () => {
    fc.assert(
      fc.property(summaryArb, (summary) => {
        const progress = fillProgress(summary);
        const expected = summary.fields.filter(
          (f) => (f.required && !f.filled) || f.invalid !== null,
        );
        expect(progress.left).toEqual(expected);
      }),
    );
  });

  it('agrees with the bar when every invalid field is required (property, FRW-078 criterion 4)', () => {
    fc.assert(
      fc.property(summaryArb, (summary) => {
        const onlyRequiredInvalid: FillSummary = {
          ...summary,
          fields: summary.fields.map((f) =>
            f.invalid !== null && !f.required ? { ...f, invalid: null } : f,
          ),
        };
        const progress = fillProgress(onlyRequiredInvalid);
        expect(progress.left.length).toBe(progress.total - progress.done);
      }),
    );
  });

  it('the required fields in the list always equal what the bar counts as left (property, FRW-078 criterion 4, owner decision 49)', () => {
    fc.assert(
      fc.property(summaryArb, (summary) => {
        const progress = fillProgress(summary);
        expect(progress.left.filter((f) => f.required).length).toBe(progress.total - progress.done);
        // The list is the bar's remainder plus the invalid optional fields, nothing else.
        const optionalInvalid = progress.left.filter((f) => !f.required);
        expect(optionalInvalid.every((f) => f.invalid !== null)).toBe(true);
        expect(progress.left.length).toBe(progress.total - progress.done + optionalInvalid.length);
      }),
    );
  });

  it('counts an invalid optional field in the list but not in the bar (both stay, owner decision 49)', () => {
    const summary: FillSummary = {
      active: true,
      fields: [
        { id: 'a', label: 'Date of birth', required: false, filled: true, invalid: 'format' },
      ],
    };
    const progress = fillProgress(summary);
    expect(progress.total - progress.done).toBe(0);
    expect(progress.left.length).toBe(1);
  });
});

describe('why a field is listed (FRW-078, criterion 1)', () => {
  it('gives a required, empty field the required reason', () => {
    expect(
      fillReasonKey({ id: 'a', label: 'A', required: true, filled: false, invalid: null }),
    ).toBe('fill.why.required');
  });

  it('maps each invalid reason code to its own message, and anything unknown to the general one', () => {
    const field = (invalid: string | null): FillField => ({
      id: 'a',
      label: 'A',
      required: true,
      filled: true,
      invalid,
    });
    expect(fillReasonKey(field('format'))).toBe('fill.why.format');
    expect(fillReasonKey(field('range'))).toBe('fill.why.range');
    expect(fillReasonKey(field('required'))).toBe('fill.why.required');
    expect(fillReasonKey(field('surprise'))).toBe('fill.why.other');
  });

  it('gives every listed field its label and a reason key, and no listed field is filled and valid (property)', () => {
    fc.assert(
      fc.property(summaryArb, (summary) => {
        const { left } = fillProgress(summary);
        for (const f of left) {
          expect(f.label.length).toBeGreaterThan(0);
          expect(fillReasonKey(f)).toMatch(/^fill\.why\./);
          expect(!(f.filled && f.invalid === null && f.required)).toBe(true);
        }
      }),
    );
  });
});

describe('the list changes as fields are fixed (FRW-078, criterion 3, the list part)', () => {
  it('drops a field from the list at once when it is filled and valid, and leaves the list empty when nothing is left', () => {
    const before: FillSummary = {
      active: true,
      fields: [
        { id: 'a', label: 'A', required: true, filled: false, invalid: null },
        { id: 'b', label: 'B', required: true, filled: true, invalid: 'format' },
      ],
    };
    expect(fillProgress(before).left.map((f) => f.id)).toEqual(['a', 'b']);
    const afterOne: FillSummary = {
      active: true,
      fields: [
        { id: 'a', label: 'A', required: true, filled: true, invalid: null },
        { id: 'b', label: 'B', required: true, filled: true, invalid: 'format' },
      ],
    };
    expect(fillProgress(afterOne).left.map((f) => f.id)).toEqual(['b']);
    const afterAll: FillSummary = {
      active: true,
      fields: afterOne.fields.map((f) => (f.id === 'b' ? { ...f, invalid: null } : f)),
    };
    expect(fillProgress(afterAll)).toMatchObject({ left: [], next: null, done: 2, total: 2 });
  });

  it('never lists a field that has been fixed, for any summary (property)', () => {
    fc.assert(
      fc.property(summaryArb, (summary) => {
        const fixed: FillSummary = {
          ...summary,
          fields: summary.fields.map((f) => ({ ...f, filled: true, invalid: null })),
        };
        expect(fillProgress(fixed).left).toEqual([]);
      }),
    );
  });
});
