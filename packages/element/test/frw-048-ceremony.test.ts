// What the screen-reader story of the ceremony needs from the element (FRW-048 criterion 2):
// "signed 2 of 3" counts the participant's own signature and initials fields, and finishing says in
// a word whether the part was completed, needs attention or could not be. Node.js, stand-ins.
import { describe, expect, it } from 'vitest';
import { completionService } from '../src/completion.ts';
import { FillActionError } from '../src/fill-actions.ts';
import { signProgress, type SignProgressSource } from '../src/signing.ts';

const field = (id: string, kind: string, assignee: string | null, filled: boolean) => ({
  id,
  kind,
  assignee,
  filled,
});

function source(
  fields: ReturnType<typeof field>[],
  roles: readonly string[] | null = ['tenant'],
): SignProgressSource {
  return {
    fillFields: () => fields,
    permissions: { get: () => (roles === null ? null : { fill: { roles } }) },
  };
}

describe('how many signature fields are signed (FRW-048 criterion 2)', () => {
  const fields = [
    field('s1', 'signature', 'tenant', true),
    field('i1', 'initials', 'tenant', false),
    field('s2', 'signature', 'tenant', false),
    field('s3', 'signature', 'landlord', false),
    field('t1', 'text', 'tenant', false),
  ];

  it('counts only the participant’s own signature and initials fields', () => {
    expect(signProgress(source(fields))).toEqual({ signed: 1, total: 3 });
  });

  it('counts the field just signed before its value has arrived', () => {
    expect(signProgress(source(fields), 'i1')).toEqual({ signed: 2, total: 3 });
    expect(signProgress(source(fields), 's2')).toEqual({ signed: 2, total: 3 });
    // A field already counted is not counted twice.
    expect(signProgress(source(fields), 's1')).toEqual({ signed: 1, total: 3 });
  });

  it('says nothing when the participant has no such field or the core names no roles', () => {
    expect(signProgress(source([field('t1', 'text', 'tenant', false)]))).toBeNull();
    expect(signProgress(source(fields, null))).toBeNull();
    expect(signProgress(source(fields, []))).toBeNull();
  });
});

describe('finishing the participant’s part (FRW-048 criterion 2)', () => {
  it('says it is done when the server completed the part', async () => {
    const service = completionService({ completeFilling: async () => ({ ok: true, result: {} }) });
    expect(await service.complete()).toEqual({ ok: true });
  });

  it('says how many fields need attention, without anything having been sent', async () => {
    const service = completionService({
      completeFilling: async () => ({
        ok: false,
        failures: [
          { key: 'a', problems: [] },
          { key: 'b', problems: [] },
        ],
      }),
    });
    expect(await service.complete()).toEqual({ ok: false, reason: 'invalid', count: 2 });
  });

  it('tells a participant who may not act from a failure of the call', async () => {
    const inactive = completionService({
      completeFilling: async () => {
        throw new FillActionError('waiting', 'the participant is waiting');
      },
    });
    expect(await inactive.complete()).toEqual({ ok: false, reason: 'not_active' });
    const broken = completionService({
      completeFilling: async () => {
        throw new Error('network');
      },
    });
    expect(await broken.complete()).toEqual({ ok: false, reason: 'failed' });
  });
});
