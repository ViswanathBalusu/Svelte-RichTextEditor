/**
 * The model of "preview as a role" (FRW-075 criteria 1 to 3, model only). The editor-side criteria
 * (fill mode drawn for the role, announcement and keyboard exit) are not built and stay open.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  endPreview,
  isFillableInPreview,
  mayCommitFromPreview,
  previewValue,
  setPreviewValue,
  startPreview,
} from '../src/shell/role-preview.ts';

const ROLES = ['role_tenant', 'role_landlord'] as const;

const fieldArb = fc.record({
  id: fc.constantFrom('f1', 'f2', 'f3', 'f4'),
  assignee: fc.option(fc.constantFrom(...ROLES), { nil: null }),
});

const editArb = fc.record({ field: fieldArb, value: fc.string({ maxLength: 8 }) });

describe('preview as a role (FRW-075)', () => {
  it('fills only the previewed role’s fields (criterion 1)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ROLES), fieldArb, (role, field) => {
        expect(isFillableInPreview(field.assignee, role)).toBe(field.assignee === role);
      }),
      { numRuns: 200 },
    );
  });

  it('never changes a field of another role or an unassigned field', () => {
    fc.assert(
      fc.property(fc.array(editArb, { maxLength: 20 }), (edits) => {
        let session = startPreview(null, 'role_tenant', 0);
        for (const e of edits) {
          const next = setPreviewValue(session, e.field, e.value);
          if (e.field.assignee !== 'role_tenant') expect(next).toBe(session);
          session = next;
        }
      }),
      { numRuns: 200 },
    );
  });

  it('never submits a commit and leaves the document values unchanged on leaving (criterion 2)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ROLES),
        fc.array(editArb, { maxLength: 20 }),
        fc.dictionary(fc.constantFrom('f1', 'f2', 'f3', 'f4'), fc.string({ maxLength: 8 })),
        (role, edits, documentValues) => {
          const before = JSON.stringify(documentValues);
          let session = startPreview(null, role, null);
          for (const e of edits) session = setPreviewValue(session, e.field, e.value);
          // The overlay is the only place a preview value lives: the document object is read, not written.
          for (const id of Object.keys(documentValues)) {
            previewValue(session, id, documentValues[id] ?? '');
          }
          endPreview(session);
          expect(mayCommitFromPreview()).toBe(false);
          expect(JSON.stringify(documentValues)).toBe(before);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('shows a typed value in the preview and the document value after leaving', () => {
    const field = { id: 'f1', assignee: 'role_tenant' };
    let session = startPreview(null, 'role_tenant', 4);
    session = setPreviewValue(session, field, 'typed');
    expect(previewValue(session, 'f1', 'stored')).toBe('typed');
    // A new preview starts with no overlay: the stored value shows again.
    const again = startPreview(null, 'role_tenant', 4);
    expect(previewValue(again, 'f1', 'stored')).toBe('stored');
  });

  it('returns the caret the author had when the preview started (criterion 3)', () => {
    fc.assert(
      fc.property(
        fc.option(fc.nat({ max: 10_000 }), { nil: null }),
        fc.array(fc.constantFrom(...ROLES), { maxLength: 5 }),
        (caret, switches) => {
          let session = startPreview(null, 'role_tenant', caret);
          for (const role of switches) session = startPreview(session, role, 999);
          expect(endPreview(session).caret).toBe(caret);
        },
      ),
      { numRuns: 200 },
    );
  });
});
