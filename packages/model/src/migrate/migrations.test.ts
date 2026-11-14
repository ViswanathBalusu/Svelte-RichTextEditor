// Schema migrations as pure functions (CDM-049). The framework is tested with test-only migrations:
// version 1 is the only CDM major version this package has, so no real migration exists yet.
import { describe, expect, it } from 'vitest';
import example from '../../fixtures/example-03-12.json' with { type: 'json' };
import { canonicalize } from '../canonical/jcs.ts';
import { CDM1 } from '../definition/cdm1.ts';
import { readDocument, supportedVersions } from '../validate/read.ts';
import { type Migration, migrate, moveExtKey } from './migrations.ts';

type Env = Record<string, unknown>;

const start = (): Env => structuredClone(example) as unknown as Env;

// Test-only: v1 to v2 moves `ext.keepWithNext` of the body's first node onto a core attribute name.
const toV2: Migration = {
  from: 1,
  to: 2,
  name: 'test: move ext.keepWithNext to keepWithNext',
  apply(env) {
    const doc = env['doc'] as { attrs?: Record<string, unknown> };
    if (doc.attrs) Object.assign(doc.attrs, moveExtKey(doc.attrs, 'keepWithNext', 'keepWithNext'));
    return { ...env, cdm: 2 };
  },
};

// Test-only: v2 to v3 mutates its argument. The framework must hide that from the caller.
const toV3: Migration = {
  from: 2,
  to: 3,
  name: 'test: mutates its input',
  apply(env) {
    (env['requires'] as string[]).push('test-only');
    return { ...env, cdm: 3 };
  },
};

describe('migrations are pure functions run by one framework (CDM-049)', () => {
  it('runs a chain and reports each step, with the target version stamped', () => {
    const r = migrate(start(), [toV2, toV3], 3);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cdm).toBe(3);
      expect(r.envelope['cdm']).toBe(3);
      expect(r.steps).toEqual([toV2.name, toV3.name]);
    }
  });

  it('gives equal canonical bytes when a migration runs twice on one document (criterion 1)', () => {
    const input = start();
    const a = migrate(input, [toV2, toV3], 3);
    const b = migrate(input, [toV2, toV3], 3);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(canonicalize(a.envelope)).toBe(canonicalize(b.envelope));
  });

  it('never changes its input, even when a migration mutates its argument', () => {
    const input = start();
    const before = canonicalize(input);
    const r = migrate(input, [toV2, toV3], 3);
    expect(r.ok).toBe(true);
    expect(canonicalize(input)).toBe(before);
    expect(input['requires']).toEqual(example.requires);
  });

  it('refuses a missing step, a downgrade, a result with the wrong version, and a bad registry', () => {
    expect(migrate(start(), [toV2], 3)).toMatchObject({ ok: false, code: 'migration_missing' });
    expect(migrate({ ...start(), cdm: 4 }, [toV2, toV3], 3)).toMatchObject({
      ok: false,
      code: 'migration_downgrade',
    });
    const wrong: Migration = { ...toV2, apply: (env) => ({ ...env, cdm: 5 }) };
    expect(migrate(start(), [wrong], 2)).toMatchObject({
      ok: false,
      code: 'migration_result_invalid',
    });
    const skipping: Migration = { from: 1, to: 3, name: 'skips', apply: (env) => env };
    expect(migrate(start(), [skipping], 3)).toMatchObject({
      ok: false,
      code: 'migration_chain_invalid',
    });
    expect(migrate(start(), [toV2, { ...toV2, name: 'again' }], 2)).toMatchObject({
      ok: false,
      code: 'migration_chain_invalid',
    });
  });

  it('moves an ext key to a core attribute and leaves nothing behind in ext (criterion 3)', () => {
    const out = moveExtKey({ id: 'p1', ext: { 'acme:keep': true, 'x:y': 1 } }, 'acme:keep', 'keep');
    expect(out).toEqual({ id: 'p1', ext: { 'x:y': 1 }, keep: true });
    const emptied = moveExtKey({ ext: { 'acme:keep': 'v' } }, 'acme:keep', 'keep');
    expect(emptied).toEqual({ ext: {}, keep: 'v' });
    const absent = { id: 'p1' };
    expect(moveExtKey(absent, 'acme:keep', 'keep')).toEqual(absent);
  });

  it('refuses a version n document with unsupported_cdm in a reader that supports only n+1, and migrates nothing on read (criterion 5)', () => {
    // A reader of version 2 (a definition whose cdm is 2) meets a version 1 document.
    const reader2 = { ...CDM1, cdm: 2 };
    const r = readDocument(start(), { def: reader2 });
    expect(r).toMatchObject({ ok: false, code: 'unsupported_cdm', version: 1 });
    expect(supportedVersions(reader2)).toEqual({ min: 2, max: 2 });
    // The reader of version 1 refuses a version 2 document the same way, with no migration run.
    expect(readDocument({ ...start(), cdm: 2 })).toMatchObject({
      ok: false,
      code: 'unsupported_cdm',
      version: 2,
    });
  });
});
