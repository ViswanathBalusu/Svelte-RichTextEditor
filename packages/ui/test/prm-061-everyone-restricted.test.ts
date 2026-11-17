/**
 * PRM-061 in the permissions pane: it never offers `everyone` on a restricted region, and the
 * explanation of `restricted` says what `everyone` means there (07 §17; owner decision 12 of
 * 2026-11-15, docs/owner-decisions-2026-11-15.md).
 */
import { describe, expect, it } from 'vitest';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { grantableCandidates } from '../src/shell/regions.ts';

const FOUND = [
  { principal: 'user:u1', name: 'Ada' },
  { principal: 'group:legal', name: 'Legal' },
  { principal: 'everyone', name: 'Everyone' },
  { principal: 7, name: 'Not a principal' },
];

describe('the principals the pane offers (PRM-061 criterion 2)', () => {
  it('drops everyone on a restricted region', () => {
    expect(grantableCandidates(FOUND, 'restricted').map((p) => p.principal)).toEqual([
      'user:u1',
      'group:legal',
    ]);
  });

  it('keeps every string principal on the other policies, as before', () => {
    for (const policy of ['inherit', 'confidential', undefined] as const)
      expect(grantableCandidates(FOUND, policy).map((p) => p.principal)).toEqual([
        'user:u1',
        'group:legal',
        'everyone',
      ]);
  });
});

describe('the explanation of restricted (PRM-061 criterion 3)', () => {
  it('says that a role cannot be given to everyone on such a region', () => {
    expect(EN_GB['permissions.policy.restricted.help']).toMatch(/cannot be given to everyone/);
  });
});
