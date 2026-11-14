// The rules fixtures (FRW-020): every case gives its expected result, here in Node.js and, through
// `pnpm test:browsers`, in Chromium, Firefox and WebKit, so the editor's engines and the
// authority's runtime agree on every one. The set covers every operator, operand and effect,
// with null rows and wrong-type rows.
import { describe, expect, it } from 'vitest';
import { type ExpressionCase, PROFILE, runFixtures } from '../conformance.ts';
import { FIELD_EFFECTS, OPERANDS, OPERATORS, ROUTING_EFFECTS } from '../language.ts';
import { RULES_VERSION } from '../version.ts';
import { FIXTURES } from './index.ts';

describe('rules fixtures', () => {
  it('all pass, reported by identifier', () => {
    const report = runFixtures(FIXTURES);
    expect(report.failed.map((f) => f.id)).toEqual([]);
    expect(report.passed.length).toBe(FIXTURES.cases.length);
    expect(report.rules).toBe(RULES_VERSION);
    expect([report.profile, report.feature]).toEqual([PROFILE.profile, PROFILE.feature]);
  });

  it('reports a failing case by its identifier', () => {
    const one = FIXTURES.cases.find(
      (c) => c.id === 'add.point-one-and-point-two',
    ) as ExpressionCase;
    const report = runFixtures({
      rules: RULES_VERSION,
      cases: [{ ...one, expect: { type: 'decimal', value: '0.30000000000000004' } }],
    });
    expect(report.failed.map((f) => f.id)).toEqual(['add.point-one-and-point-two']);
    expect(report.failed[0]!.actual).toEqual({ type: 'decimal', value: '0.3' });
  });

  it('have unique identifiers', () => {
    const ids = FIXTURES.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cover every operator, operand and effect, with null and wrong-type rows', () => {
    const covered = new Set(FIXTURES.cases.flatMap((c) => c.covers));
    for (const name of [...OPERATORS, ...OPERANDS, ...FIELD_EFFECTS, ...ROUTING_EFFECTS])
      expect(covered.has(name), name).toBe(true);
    const tagged = (tag: string) =>
      new Set(FIXTURES.cases.filter((c) => c.tags?.includes(tag)).flatMap((c) => c.covers));
    const nullRows = tagged('null');
    const typeRows = tagged('type');
    for (const op of OPERATORS) {
      expect(nullRows.has(op), `null row for ${op}`).toBe(true);
      // empty accepts every type, so it has no wrong-type row.
      if (op !== 'empty') expect(typeRows.has(op), `wrong-type row for ${op}`).toBe(true);
    }
  });

  it('cover each category the decision record proposes', () => {
    const categories = new Set(FIXTURES.cases.map((c) => c.category));
    expect([...categories].sort()).toEqual([
      'dates',
      'decimal',
      'invalid',
      'operators',
      'patterns',
      'rules',
      'values',
    ]);
    const tags = new Set(FIXTURES.cases.flatMap((c) => c.tags ?? []));
    for (const t of ['null', 'type', 'currency', 'dst', 'pathological'])
      expect(tags.has(t), t).toBe(true);
  });
});
