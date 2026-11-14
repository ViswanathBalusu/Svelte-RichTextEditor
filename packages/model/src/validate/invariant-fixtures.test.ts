// The invariant fixtures (CDM-014): a base document, the steps of a commit and the invariants its
// result breaks, for every invariant and at both sides of every limit, in the format the
// authority and other implementations replay. Fuzz regressions (CDM-015) use the same format.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type { InvariantFixture } from '../../scripts/invariant-fixtures.ts';
import { cdmSchema } from '../prosemirror/index.ts';
import type { ValidationContext } from './types.ts';
import { validate } from './validate.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const fixtures = resolve(import.meta.dirname, '../../fixtures');
const dir = resolve(fixtures, 'invariants');
const BASES: Record<string, string> = {
  example: 'example-03-12.json',
  'kitchen-sink': 'kitchen-sink.json',
};

function load(sub: string): InvariantFixture[] {
  const d = resolve(dir, sub);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(resolve(d, f), 'utf8')) as InvariantFixture);
}

/** Expands `{ "$repeat": s, "count": n }` into s repeated n times. */
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

function baseOf(f: InvariantFixture): Json {
  if (typeof f.base !== 'string') return structuredClone(f.base);
  return JSON.parse(
    readFileSync(resolve(fixtures, BASES[f.base] ?? `${f.base}.json`), 'utf8'),
  ) as Json;
}

/** Applies the steps to the base and validates the result with the fixture's context. */
function replay(f: InvariantFixture): { invariants: string[]; failedStep: number | null } {
  const schema = cdmSchema();
  const base = baseOf(f);
  // A fixture without steps is a stored document, which may be one ProseMirror cannot even build.
  let doc = f.steps.length ? schema.nodeFromJSON(base['doc']) : null;
  for (const [i, json] of (expand(f.steps) as Json[]).entries()) {
    const r = Step.fromJSON(schema, json).apply(doc!);
    if (r.failed || !r.doc) return { invariants: [], failedStep: i };
    doc = r.doc;
  }
  const c = f.context;
  const gate = c.mathGateRefuses;
  const ctx: ValidationContext = {
    ...(c.attachedAssets ? { attachedAssets: new Set(c.attachedAssets) } : {}),
    ...(c.retiredRegionIds ? { retiredRegionIds: new Set(c.retiredRegionIds) } : {}),
    ...(gate !== undefined
      ? { mathGate: (latex: string) => (latex.includes(gate) ? `${gate} is not allowed` : null) }
      : {}),
    ...(c.identifierChanges ? { identifierChanges: c.identifierChanges } : {}),
  };
  const envelope = {
    cdm: 1,
    requires: f.requires ?? base['requires'],
    doc: doc ? doc.toJSON() : base['doc'],
  };
  return {
    invariants: [...new Set(validate(envelope, ctx).violations.map((v) => v.invariant))].sort(),
    failedStep: null,
  };
}

const cases = load('cases');
const regressions = load('regressions');

describe('invariant fixtures (CDM-014)', () => {
  it('give at least one failing fixture for every invariant I1 to I15', () => {
    const broken = new Set(cases.flatMap((c) => c.expected));
    for (let i = 1; i <= 15; i++) expect(broken.has(`I${i}`), `I${i}`).toBe(true);
  });

  it('give every numeric limit a passing and a failing boundary', () => {
    const limits = new Map<string, Set<string>>();
    for (const c of cases)
      if (c.limit)
        limits.set(c.limit.name, (limits.get(c.limit.name) ?? new Set()).add(c.limit.side));
    for (const name of [
      'regions',
      'tableColumns',
      'depth',
      'basedOnDepth',
      'latex',
      'canonicalBytes',
      'payload',
      'fields',
    ])
      expect([...(limits.get(name) ?? [])].sort(), name).toEqual(['at', 'past']);
  });

  it('are a base document, steps in step JSON and the expected invariants, using all seven step types', () => {
    const types = new Set(
      cases.flatMap((c) => c.steps.map((s) => String((s as Json)['stepType']))),
    );
    expect([...types].sort()).toEqual([
      'addMark',
      'addNodeMark',
      'attr',
      'removeMark',
      'removeNodeMark',
      'replace',
      'replaceAround',
    ]);
    for (const c of cases) {
      expect(c.base, c.name).toBeDefined();
      expect(Array.isArray(c.steps), c.name).toBe(true);
      expect(c.expected, c.name).toEqual([...c.expected].sort());
    }
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    '%s: validate() returns exactly the expected invariants',
    (_name, c) => {
      const r = replay(c);
      expect(r.failedStep, 'every step applies').toBeNull();
      expect(r.invariants).toEqual(c.expected);
    },
  );

  it('replay the regressions that fuzzing saved in the same format (CDM-015)', () => {
    for (const r of regressions) expect(replay(r).invariants, r.name).toEqual(r.expected);
  });
});
