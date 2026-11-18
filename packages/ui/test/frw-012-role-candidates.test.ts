// FRW-012 criterion 4: the grants dialog offers the document's role placeholders beside users and
// groups. `roleCandidates` is the rule: the roles whose name contains the text typed, as principals
// `role:<id>`; the browser run is packages/element/e2e/frw-012-role-grant.spec.ts.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { roleCandidates } from '../src/shell/regions.ts';

const ROLES = [
  { id: 'role_tenant', name: 'Tenant' },
  { id: 'role_landlord', name: 'Landlord' },
  { id: 'role_reviewer', name: 'Reviewer' },
];

describe('role placeholders as grant candidates (FRW-012 criterion 4)', () => {
  it('lists a role as `role:<id>` with its name when the text matches, ignoring case', () => {
    expect(roleCandidates(ROLES, 'rev')).toEqual([
      { principal: 'role:role_reviewer', name: 'Reviewer' },
    ]);
    expect(roleCandidates(ROLES, ' LAND ')).toEqual([
      { principal: 'role:role_landlord', name: 'Landlord' },
    ]);
  });

  it('lists every role that matches, in the document order', () => {
    expect(roleCandidates(ROLES, 'e').map((c) => c.principal)).toEqual([
      'role:role_tenant',
      'role:role_reviewer',
    ]);
  });

  it('lists nothing for empty text or for a text no role contains', () => {
    expect(roleCandidates(ROLES, '')).toEqual([]);
    expect(roleCandidates(ROLES, '   ')).toEqual([]);
    expect(roleCandidates(ROLES, 'witness')).toEqual([]);
    expect(roleCandidates([], 'tenant')).toEqual([]);
  });

  it('only ever names a principal of the form `role:<id>` of a role of the document (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), (text) => {
        for (const c of roleCandidates(ROLES, text)) {
          expect(c.principal.startsWith('role:')).toBe(true);
          expect(ROLES.some((r) => `role:${r.id}` === c.principal && r.name === c.name)).toBe(true);
        }
      }),
    );
  });
});
