// CDM-014 criterion 4 (lane U-CDM-001-027): the authority's step 6 rejects every failing invariant
// fixture of packages/model/fixtures/invariants with `invalid_op`, or `field_invalid` when the only
// violations are wrong field values (the rule in checkInvariants). Replays each fixture through
// applySteps and checkInvariants, the authority's own functions. Storage of a refused commit is the
// Room's and is not covered here.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cdmSchema } from '@docedit/model/prosemirror';
import { Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { applySteps } from '../src/rebase.ts';
import { checkInvariants } from '../src/invariants.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const fixtures = resolve(import.meta.dirname, '../../model/fixtures');
const casesDir = resolve(fixtures, 'invariants/cases');
const BASES: Record<string, string> = {
  example: 'example-03-12.json',
  'kitchen-sink': 'kitchen-sink.json',
};

const cases = readdirSync(casesDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(resolve(casesDir, f), 'utf8')) as Json);

function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') {
    const o = value as Json;
    if (typeof o['$repeat'] === 'string' && typeof o['count'] === 'number')
      return o['$repeat'].repeat(o['count']);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, expand(v)]));
  }
  return value;
}

function baseOf(f: Json): Json {
  if (typeof f['base'] !== 'string') return structuredClone(f['base']) as Json;
  const name = BASES[f['base']] ?? `${f['base']}.json`;
  return JSON.parse(readFileSync(resolve(fixtures, name), 'utf8')) as Json;
}

/** Runs the fixture through the authority's step 6 and returns the result. */
function judge(f: Json) {
  const schema = cdmSchema();
  const base = baseOf(f);
  const before = schema.nodeFromJSON(base['doc']);
  const steps = (expand(f['steps']) as Json[]).map((j) => Step.fromJSON(schema, j));
  const applied = applySteps(before, steps);
  if (!applied.ok) return { ok: false as const, code: 'invalid_op', reason: applied.reason };
  const c = f['context'] as Json;
  const gate = c['mathGateRefuses'];
  return checkInvariants(before, applied.value.doc, steps, applied.value.docs, {
    requires: (f['requires'] ?? base['requires']) as string[],
    retiredRegionIds: new Set<string>(c['retiredRegionIds'] ?? []),
    ...(c['attachedAssets'] ? { attachedAssets: new Set<string>(c['attachedAssets']) } : {}),
    ...(gate !== undefined
      ? { mathGate: (latex: string) => (latex.includes(gate) ? `${gate} is not allowed` : null) }
      : {}),
  });
}

describe('CDM-014 step 6 refuses the failing fixtures', () => {
  it('reads the fixtures', () => {
    expect(cases.length).toBeGreaterThanOrEqual(48);
  });

  // A fixture with expected invariants is a failing one: step 6 must refuse it. A fixture with none
  // is the passing side of a limit (`at`): step 6 must accept it.
  const failing = cases.filter((c) => (c['expected'] as string[]).length > 0);
  const passing = cases.filter((c) => (c['expected'] as string[]).length === 0);

  it.each(failing.map((c) => [String(c['name']), c] as const))(
    '%s is refused with invalid_op or field_invalid',
    (_name, c) => {
      const r = judge(c);
      expect(r.ok, r.ok ? 'accepted' : r.reason).toBe(false);
      if (!r.ok) expect(['invalid_op', 'field_invalid']).toContain(r.code);
    },
  );

  it.each(passing.map((c) => [String(c['name']), c] as const))(
    '%s (passing side of a limit) is accepted',
    (_name, c) => {
      const r = judge(c);
      expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    },
  );
});
