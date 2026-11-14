// The request for the final PDF of a completed workflow (12 §8.2 step 1; FRW-049 criteria 1, 2, 5).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type WorkflowStatus, finalExportRequest } from '../src/workflow/final-export.ts';

const STATUSES: readonly WorkflowStatus[] = [
  'draft',
  'sent',
  'in_progress',
  'correcting',
  'completed',
  'finalised',
  'voided',
  'declined',
  'expired',
];

describe('the final export is pinned to completedSeq (FRW-049 criterion 2)', () => {
  it('asks for the document at completedSeq, flattened, with the final profile', () => {
    fc.assert(
      fc.property(fc.nat(), (seq) => {
        const v = finalExportRequest('completed', seq, { seal: 'pades-b-lta', certificate: true });
        expect(v).toEqual({
          ok: true,
          request: { seq, fields: 'flatten', profile: 'final', certificate: true },
        });
      }),
    );
  });

  it('refuses a completedSeq that is not a non-negative safe integer', () => {
    for (const seq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(finalExportRequest('completed', seq, undefined)).toEqual({
        ok: false,
        reason: 'bad_completed_seq',
      });
    }
  });
});

describe('certificate pages follow finalisation.certificate (FRW-049 criterion 5)', () => {
  it('asks for certificate pages only when the option is true', () => {
    const on = finalExportRequest('completed', 4, { certificate: true });
    const off = finalExportRequest('completed', 4, { certificate: false });
    expect(on.ok && on.request.certificate).toBe(true);
    expect(off.ok && off.request.certificate).toBe(false);
  });

  it('reads an absent option as no certificate pages', () => {
    const absent = finalExportRequest('completed', 4, { seal: 'pades-b-lta' });
    expect(absent.ok && absent.request.certificate).toBe(false);
    const none = finalExportRequest('completed', 4, undefined);
    expect(none.ok && none.request.certificate).toBe(false);
  });
});

describe('only a completed workflow is exported (FRW-049 criterion 1)', () => {
  it('refuses every state other than completed', () => {
    for (const status of STATUSES.filter((s) => s !== 'completed')) {
      expect(finalExportRequest(status, 3, { certificate: true })).toEqual({
        ok: false,
        reason: 'not_completed',
      });
    }
  });
});
