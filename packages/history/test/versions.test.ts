// Creating a stored version (08 §4; HIS-006 criteria 2 and 3, HIS-007 criteria 5 and 6): only one
// version per document, seq and kind; a kind outside the seven of 08 §4 is refused; a seq above the
// head or below the caller's gate is refused.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createVersion, isVersionKind, type VersionRules } from '../src/versions.ts';
import { VERSION_KINDS, type StoredVersion } from '../src/types.ts';

const rules = (over: Partial<VersionRules> = {}): VersionRules => ({
  canEdit: true,
  head: 10,
  gate: { min: 4, head: 10 },
  ...over,
});

const base = {
  seq: 7,
  kind: 'named',
  name: 'Sent to legal',
  note: 'after the second round',
  createdBy: 'alice',
  createdAt: 1_000,
};

const req = (over: Partial<typeof base> = {}) => ({ ...base, ...over });

describe('creating a stored version (HIS-006, HIS-007)', () => {
  it('stores a named version pointing at the seq, with its creator and time (HIS-006 criterion 1, the rule)', () => {
    const r = createVersion([], req(), rules());
    expect(r).toEqual({
      ok: true,
      created: true,
      version: {
        seq: 7,
        kind: 'named',
        name: 'Sent to legal',
        note: 'after the second round',
        createdBy: 'alice',
        createdAt: 1_000,
      },
    });
  });

  it('refuses a seq above the head and a seq below the gate (HIS-006 criterion 3)', () => {
    expect(createVersion([], req({ seq: 11 }), rules())).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(createVersion([], req({ seq: 3 }), rules())).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    // The gate's edge and the head are allowed.
    expect(createVersion([], req({ seq: 4 }), rules()).ok).toBe(true);
    expect(createVersion([], req({ seq: 10 }), rules()).ok).toBe(true);
  });

  it('refuses a requester without edit somewhere in the document (HIS-006 criterion 2, the caller passes canEdit)', () => {
    expect(createVersion([], req(), rules({ canEdit: false }))).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });

  it('returns the stored version when the same document, seq and kind is requested twice (HIS-007 criterion 5)', () => {
    const first = createVersion([], req(), rules());
    if (!first.ok) throw new Error('first creation refused');
    const stored: StoredVersion[] = [first.version];
    const again = createVersion(stored, req({ createdBy: 'bob', createdAt: 2_000 }), rules());
    expect(again).toEqual({ ok: true, created: false, version: first.version });
    // A different kind at the same seq is a version of its own.
    const other = createVersion(stored, req({ kind: 'export' }), rules());
    expect(other).toMatchObject({ ok: true, created: true, version: { kind: 'export', seq: 7 } });
  });

  it('refuses a kind outside the seven of 08 §4, and accepts each of the seven (HIS-007 criterion 6)', () => {
    for (const kind of ['group', 'auto', 'checkpoint', '', 'Named']) {
      expect(createVersion([], req({ kind }), rules())).toMatchObject({
        ok: false,
        code: 'validation_failed',
      });
    }
    for (const kind of VERSION_KINDS) {
      expect(isVersionKind(kind)).toBe(true);
      expect(createVersion([], req({ kind }), rules()).ok).toBe(true);
    }
    expect(VERSION_KINDS).toEqual([
      'named',
      'export',
      'pre-restore',
      'restore',
      'import',
      'sent',
      'completed',
    ]);
  });

  it('never stores two versions for one seq and kind, whatever is requested (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            seq: fc.integer({ min: 0, max: 12 }),
            kind: fc.constantFrom(...VERSION_KINDS, 'group'),
          }),
          { maxLength: 40 },
        ),
        (reqs) => {
          let stored: StoredVersion[] = [];
          for (const r of reqs) {
            const out = createVersion(stored, req(r), rules());
            if (out.ok && out.created) stored = [...stored, out.version];
          }
          const keys = stored.map((v) => `${v.seq}:${v.kind}`);
          expect(new Set(keys).size).toBe(keys.length);
        },
      ),
    );
  });
});
