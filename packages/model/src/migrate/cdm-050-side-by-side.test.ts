// CDM-050 criteria 1 and 3: the readers of two CDM versions in one process, and a checkpoint read
// by the reader of the version it was written at, before and after a migration (03 §11.3; owner
// decisions 58, 75 and 76). Version n is the test-only version 2 of test/cdm2-test-only.ts, as
// decision 76 says: nothing of it ships.
import { describe, expect, it } from 'vitest';
import before from '../../fixtures/migrations/v1-to-v2/before.json' with { type: 'json' };
import { CDM2_TEST_ONLY, MIGRATE_V1_TO_V2 } from '../../test/cdm2-test-only.ts';
import { CDM1 } from '../definition/cdm1.ts';
import { readDocument } from '../validate/read.ts';
import { readerSet } from '../validate/readers.ts';
import { validate } from '../validate/validate.ts';
import { migrate } from './migrations.ts';

const v1 = (): Record<string, unknown> => structuredClone(before) as Record<string, unknown>;
const v2 = (): Record<string, unknown> => {
  const r = migrate(v1(), [MIGRATE_V1_TO_V2], 2);
  if (!r.ok) throw new Error(r.message);
  return r.envelope as unknown as Record<string, unknown>;
};

/** What a read comes to, without the ProseMirror document: the outcome a caller sees. */
const outcome = (r: ReturnType<typeof readDocument>): unknown =>
  r.ok ? { ok: true, cdm: r.cdm, json: r.doc.toJSON() as unknown } : r;

describe('two CDM versions in one process (CDM-050 criterion 1)', () => {
  const set = readerSet([CDM2_TEST_ONLY, CDM1]);

  it('holds the versions in order and reports the range an operator checks', () => {
    expect(set.versions).toEqual([1, 2]);
    expect(set.supported).toEqual({ min: 1, max: 2 });
    expect(set.definition(1)).toBe(CDM1);
    expect(set.definition(2)).toBe(CDM2_TEST_ONLY);
    expect(set.definition(3)).toBeUndefined();
  });

  it('reads a version 1 document with version 1 and a version 2 document with version 2', () => {
    const a = set.read(v1());
    const b = set.read(v2());
    expect(a.ok && a.cdm).toBe(1);
    expect(b.ok && b.cdm).toBe(2);
  });

  it('gives each reader the result it gives alone, in any order and after the other has run', () => {
    const alone1 = outcome(readDocument(v1(), { def: CDM1 }));
    const alone2 = outcome(readDocument(v2(), { def: CDM2_TEST_ONLY }));
    for (const order of [
      [1, 2, 1, 2],
      [2, 2, 1, 1],
      [2, 1, 2, 1],
    ])
      for (const which of order)
        expect(outcome(set.read(which === 1 ? v1() : v2()))).toEqual(which === 1 ? alone1 : alone2);
    // The single readers still behave as before the set ran: version 1 refuses version 2.
    const refused = readDocument(v2(), { def: CDM1 });
    expect(refused.ok === false && refused.code).toBe('unsupported_cdm');
    expect(validate(v1(), { def: CDM1 }).valid).toBe(true);
    expect(validate(v2(), { def: CDM2_TEST_ONLY }).valid).toBe(true);
  });

  it('keeps the attribute that only version 2 has out of version 1 and in version 2', () => {
    const paragraphs = (doc: unknown): Record<string, unknown>[] => {
      const out: Record<string, unknown>[] = [];
      const walk = (n: Record<string, unknown>): void => {
        if (n['type'] === 'paragraph') out.push((n['attrs'] ?? {}) as Record<string, unknown>);
        for (const c of (n['content'] as Record<string, unknown>[] | undefined) ?? []) walk(c);
      };
      walk(doc as Record<string, unknown>);
      return out;
    };
    const a = set.read(v1());
    const b = set.read(v2());
    if (!a.ok || !b.ok) throw new Error('both must read');
    expect(paragraphs(a.doc.toJSON()).some((p) => 'keepTogether' in p)).toBe(false);
    expect(paragraphs(b.doc.toJSON()).some((p) => 'keepTogether' in p)).toBe(true);
  });

  it('refuses a version it does not hold with the range it does hold', () => {
    for (const cdm of [0, 3, 1.5, '1', null]) {
      const r = set.read({ ...v1(), cdm });
      expect(r.ok).toBe(false);
    }
    const r = set.read({ ...v1(), cdm: 3 });
    expect(r.ok === false && r.code).toBe('unsupported_cdm');
    expect(r.ok === false && 'supported' in r && r.supported).toEqual({ min: 1, max: 2 });
    expect(set.read('not a document').ok).toBe(false);
  });

  it('refuses two definitions of one version, and an empty set', () => {
    expect(() => readerSet([CDM1, CDM1])).toThrow(/version 1/);
    expect(() => readerSet([])).toThrow(/at least one/);
  });
});

describe('history reads a checkpoint with the package of its version (CDM-050 criterion 3)', () => {
  // A checkpoint is an envelope. One written before the migration has `cdm: 1`; the snapshot
  // commit of the migration is followed by a checkpoint with `cdm: 2` (03 §11.3). A replay holds
  // the reader of each, and no read starts a migration.
  const before1 = v1();
  const after2 = v2();

  it('loads and validates the checkpoint before the migration with the older reader', () => {
    const older = readerSet([CDM1]);
    const r = older.read(before1);
    expect(r.ok && r.cdm).toBe(1);
    // The older reader alone cannot read the later checkpoint: it is refused, not migrated.
    const later = older.read(after2);
    expect(later.ok === false && later.code).toBe('unsupported_cdm');
  });

  it('loads and validates the checkpoint after the migration with the newer reader', () => {
    const newer = readerSet([CDM2_TEST_ONLY]);
    const r = newer.read(after2);
    expect(r.ok && r.cdm).toBe(2);
    const earlier = newer.read(before1);
    expect(earlier.ok === false && earlier.code).toBe('unsupported_cdm');
  });

  it('reads a history that crosses the migration when both packages are kept, and migrates nothing', () => {
    const both = readerSet([CDM1, CDM2_TEST_ONLY]);
    const checkpoints = [before1, after2];
    const snapshot = JSON.stringify(checkpoints);
    const read = checkpoints.map((c) => both.read(c));
    expect(read.map((r) => r.ok && r.cdm)).toEqual([1, 2]);
    expect(read.every((r) => r.ok && r.notChecked !== undefined)).toBe(true);
    expect(JSON.stringify(checkpoints)).toBe(snapshot);
  });
});
