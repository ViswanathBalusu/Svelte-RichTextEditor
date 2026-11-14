// The licence gate's policy (FND-011).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Policy, activeException, evaluate, parseSpdx } from './licence-policy.ts';

const policy = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../licences/policy.json'), 'utf8'),
) as Policy;

describe('licence policy', () => {
  it('allows the permissive licences of the borrow list', () => {
    for (const l of ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', '0BSD', '(MIT AND Zlib)'])
      expect(evaluate(l, policy).ok, l).toBe(true);
  });

  it('refuses copyleft, source-available and missing licences, naming the licence', () => {
    for (const l of [
      'GPL-3.0-only',
      'AGPL-3.0',
      'LGPL-2.1-or-later',
      'SSPL-1.0',
      'BUSL-1.1',
      'CC-BY-SA-4.0',
      'UNKNOWN',
      undefined,
    ]) {
      const v = evaluate(l, policy);
      expect(v.ok, String(l)).toBe(false);
    }
    const v = evaluate('GPL-2.0', policy);
    if (!v.ok) expect(v.reason).toContain('GPL-2.0');
  });

  it('passes a dual licence only as dual, so the gate can require a recorded choice', () => {
    expect(evaluate('(MIT OR GPL-3.0-or-later)', policy)).toEqual({ ok: true, dual: true });
    expect(evaluate('MPL-2.0 OR Apache-2.0', policy)).toEqual({ ok: true, dual: true });
    expect(evaluate('MIT AND GPL-2.0', policy).ok).toBe(false);
  });

  it('allows fonts and data under their own lists only', () => {
    expect(evaluate('OFL-1.1', policy).ok).toBe(false);
    expect(evaluate('OFL-1.1', policy, 'font').ok).toBe(true);
    expect(evaluate('CC0-1.0', policy, 'data').ok).toBe(true);
  });

  it('honours exceptions until they expire', () => {
    const list = [
      {
        package: 'x',
        licence: 'MPL-2.0',
        reason: 'test tool',
        decision: 'ADR 9999',
        expires: '2026-12-31',
      },
    ];
    expect(activeException(list, 'x', '1.0.0', '2026-11-06')).not.toBeNull();
    expect(activeException(list, 'x', '1.0.0', '2027-01-01')).toBeNull();
  });

  it('parses SPDX expressions with WITH and parentheses', () => {
    expect(parseSpdx('Apache-2.0 WITH LLVM-exception')).toEqual({ t: 'id', id: 'Apache-2.0' });
    expect(parseSpdx('(A OR (B AND C))')).not.toBeNull();
    expect(parseSpdx('A OR')).toBeNull();
  });
});
