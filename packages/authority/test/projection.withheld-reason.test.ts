// ADR 0019: an `invalid_op` reason built on the full document (a ProseMirror error, a validator
// message) can quote hidden content. A read-restricted reader gets the step index only.
import { describe, expect, it } from 'vitest';
import { withheldReason } from '../src/projection/gateway.ts';

describe('the reason a read-restricted reader receives for invalid_op', () => {
  it('keeps the step index and drops the rest', () => {
    expect(
      withheldReason(
        'step 2 threw: Invalid content for node region: <paragraph("TOPSECRET-LEGAL")>',
      ),
    ).toBe('step 2 does not apply to the document');
  });

  it('says nothing of the document when the room named no step', () => {
    const reason = withheldReason('I15 /content/1/attrs/value: TOPSECRET-VALUE is not an integer');
    expect(reason).toBe('the commit does not apply to the document');
    expect(reason).not.toContain('TOPSECRET');
  });
});
