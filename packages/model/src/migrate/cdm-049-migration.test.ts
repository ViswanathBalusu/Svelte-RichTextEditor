// CDM-049 criteria 1 to 3 on a real migration: the test-only version 2 of
// test/cdm2-test-only.ts (owner decisions 75 and 76). The fixtures are in
// fixtures/migrations/v1-to-v2: `before.json` (version 1), `after.json` (version 2) and
// `expected.json` (the canonical hash of the result, and what moved).
import { afterEach, describe, expect, it, vi } from 'vitest';
import after from '../../fixtures/migrations/v1-to-v2/after.json' with { type: 'json' };
import before from '../../fixtures/migrations/v1-to-v2/before.json' with { type: 'json' };
import expected from '../../fixtures/migrations/v1-to-v2/expected.json' with { type: 'json' };
import { CDM2_TEST_ONLY, EXT_KEY, MIGRATE_V1_TO_V2 } from '../../test/cdm2-test-only.ts';
import { canonicalText, documentHash, type JsonEnvelope } from '../canonical/canonical-form.ts';
import { CDM1 } from '../definition/cdm1.ts';
import { attributeShapeChanges } from '../definition/evolution.ts';
import { validate } from '../validate/validate.ts';
import { migrate } from './migrations.ts';

type Json = Record<string, unknown>;
const input = (): Json => structuredClone(before) as unknown as Json;
const run = (env: Json = input()) => {
  const r = migrate(env, [MIGRATE_V1_TO_V2], 2);
  if (!r.ok) throw new Error(r.message);
  return r;
};
const asEnvelope = (j: Json): JsonEnvelope => j as unknown as JsonEnvelope;

/** Every node of a document, with its attributes. */
function nodes(node: Json, out: Json[] = []): Json[] {
  out.push(node);
  if (Array.isArray(node['content'])) for (const c of node['content']) nodes(c as Json, out);
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe('the test-only migration from version 1 to version 2 (CDM-049)', () => {
  it('is a change of one attribute, from ext to the core, and nothing else (03 §11.2)', () => {
    expect(attributeShapeChanges(CDM1, CDM2_TEST_ONLY)).toEqual([
      { kind: 'node', name: 'paragraph', attribute: 'keepTogether', change: 'gained' },
    ]);
  });

  it('starts from a valid version 1 document and ends at a valid version 2 document (criterion 2)', () => {
    expect(validate(before, { def: CDM1 }).violations).toEqual([]);
    const result = run();
    expect(result.cdm).toBe(2);
    expect(result.steps).toEqual([MIGRATE_V1_TO_V2.name]);
    expect(validate(result.envelope, { def: CDM2_TEST_ONLY }).violations).toEqual([]);
    // Version 1 refuses the result, and version 2 refuses the input: the stamps differ.
    expect(validate(result.envelope, { def: CDM1 }).valid).toBe(false);
    expect(validate(before, { def: CDM2_TEST_ONLY }).valid).toBe(false);
  });

  it('gives the canonical hash and the document of the fixture (criterion 2)', async () => {
    const result = run();
    expect(await documentHash(asEnvelope(result.envelope), CDM2_TEST_ONLY)).toBe(
      expected.canonicalHash,
    );
    // The fixture's after.json is the same document in canonical form, and has the same hash.
    expect(canonicalText(asEnvelope(result.envelope), CDM2_TEST_ONLY)).toBe(
      canonicalText(asEnvelope(after as unknown as Json), CDM2_TEST_ONLY),
    );
    expect(await documentHash(asEnvelope(after as unknown as Json), CDM2_TEST_ONLY)).toBe(
      expected.canonicalHash,
    );
  });

  it('gives equal canonical bytes on a second run, and reads no clock and no randomness (criterion 1)', () => {
    const trap = (what: string) => () => {
      throw new Error(`the migration read ${what}`);
    };
    vi.spyOn(Date, 'now').mockImplementation(trap('the clock'));
    vi.spyOn(Math, 'random').mockImplementation(trap('a random number'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(trap('the network') as never);
    const doc = input();
    const first = canonicalText(asEnvelope(run(doc).envelope), CDM2_TEST_ONLY);
    const second = canonicalText(asEnvelope(run(doc).envelope), CDM2_TEST_ONLY);
    expect(second).toBe(first);
    // The input was not changed by either run.
    expect(doc).toEqual(before);
    // The migration itself, called without the framework, also leaves its argument alone.
    const direct = input();
    MIGRATE_V1_TO_V2.apply(direct);
    expect(direct).toEqual(before);
  });

  it('moves the value to the core attribute and leaves nothing behind in ext (criterion 3)', () => {
    const result = run();
    const out = nodes(result.envelope['doc'] as Json);
    for (const n of out) {
      const attrs = (n['attrs'] ?? {}) as Json;
      expect(Object.keys((attrs['ext'] ?? {}) as Json), String(attrs['id'])).not.toContain(EXT_KEY);
    }
    const byId = (id: string): Json =>
      (out.find((n) => ((n['attrs'] ?? {}) as Json)['id'] === id) as Json)['attrs'] as Json;
    for (const m of expected.moved) expect(byId(m.node)['keepTogether']).toBe(m.value);
    // Another key of ext is not touched.
    for (const k of expected.keptInExt) expect((byId(k.node)['ext'] as Json)[k.key]).toBe('review');
    // A paragraph that never had the key gets no attribute.
    const untouched = out.filter(
      (n) => n['type'] === 'paragraph' && !('keepTogether' in ((n['attrs'] ?? {}) as Json)),
    );
    expect(untouched.length).toBeGreaterThan(0);
  });
});
