/**
 * The words about regions the user cannot edit (PRM-026 criteria 1, 2 and 5; ADR 0019). Names come
 * from the host's directory through `nameOf`, the derived region list supplies the editors, and a
 * region the reader may not see is described only as hidden.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { AccessObject, AccessSummary, RegionSummary } from '../src/core-api.ts';
import { sourceTranslator } from '../src/i18n/strings.ts';
import {
  mayEditRegion,
  regionLabels,
  scopeAnnouncement,
  whoCanEdit,
} from '../src/shell/regions.ts';

const tr = sourceTranslator();
const NAMES: Record<string, string> = {
  'user:u1': 'Ada',
  'user:u2': 'Grace',
  'group:g1': 'Editors',
};
const nameOf = (principal: string): string => NAMES[principal] ?? principal;

function region(over: Partial<RegionSummary> & { id: string }): RegionSummary {
  return { title: 'Clause 4', policy: 'inherit', order: 0, state: 'draft', ...over };
}

function access(scopes: Record<string, readonly string[]>): AccessObject {
  return { rev: 1, docRole: 'viewer', caps: ['view'], scopes };
}

describe('who can edit a region, in words (PRM-026, criterion 2)', () => {
  it('names the principals with an editor grant, resolved through the host directory', () => {
    const text = whoCanEdit(
      region({ id: 'r1', editors: { roles: [], principals: ['user:u1', 'group:g1'] } }),
      tr,
      nameOf,
    );
    expect(text).toBe('It can be edited by Ada and Editors.');
  });

  it('names document roles as well as grantees', () => {
    const text = whoCanEdit(
      region({ id: 'r1', editors: { roles: ['editor', 'owner'], principals: ['user:u2'] } }),
      tr,
      nameOf,
    );
    expect(text).toBe('It can be edited by Grace, and by document editors and owners.');
  });

  it('says who holds the lease while they are editing', () => {
    const text = whoCanEdit(
      region({ id: 'r1', editors: { roles: ['editor'], principals: [], leasedTo: 'u1' } }),
      tr,
      nameOf,
    );
    expect(text).toBe('Ada is editing it at the moment.');
  });

  it('says nobody can edit an approved region, and nobody when no one holds a grant', () => {
    expect(whoCanEdit(region({ id: 'r1', state: 'approved' }), tr, nameOf)).toBe(
      'It is approved, so nobody can edit it.',
    );
    expect(
      whoCanEdit(region({ id: 'r1', editors: { roles: [], principals: [] } }), tr, nameOf),
    ).toBe('Nobody can edit it at the moment.');
  });

  it('describes a region the reader may not see only as hidden, naming nobody (ADR 0019)', () => {
    const hidden = region({ id: 'r9', title: null });
    expect(whoCanEdit(hidden, tr, nameOf)).toBe(tr.t('reason.access.hidden'));
    const seen: string[] = [];
    whoCanEdit(hidden, tr, (p) => (seen.push(p), p));
    expect(seen).toEqual([]);
  });
});

describe('lock indicators (PRM-026, criterion 1, the shell side)', () => {
  it('gives a label to exactly the regions the user cannot edit (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 40 }), { maxLength: 12 }),
        fc.uniqueArray(fc.integer({ min: 1, max: 40 }), { maxLength: 12 }),
        (ids, editable) => {
          const regions = ids.map((n, i) => region({ id: `r${n}`, order: i }));
          const scopes: Record<string, string[]> = {};
          for (const n of editable) scopes[`region:r${n}`] = ['view', 'edit'];
          const labels = regionLabels(regions, access(scopes), tr, nameOf);
          const expected = regions
            .filter((r) => !mayEditRegion(access(scopes), r.id))
            .map((r) => r.id);
          expect(Object.keys(labels).sort()).toEqual(expected.sort());
          for (const label of Object.values(labels)) {
            expect(label.indicator).toBe('Read-only');
            expect(label.description.length).toBeGreaterThan(0);
          }
        },
      ),
    );
  });

  it('labels a region the user may only suggest in, since they cannot edit it', () => {
    const labels = regionLabels(
      [region({ id: 'r1' })],
      access({ 'region:r1': ['view', 'suggest'] }),
      tr,
      nameOf,
    );
    expect(Object.keys(labels)).toEqual(['r1']);
  });
});

describe('announcing a read-only region when the caret enters it (PRM-026, criterion 5)', () => {
  const regions = [
    region({ id: 'r1', title: 'Clause 4', editors: { roles: [], principals: ['user:u1'] } }),
    region({ id: 'r2', title: null }),
  ];
  const at = (
    scope: string,
    caps: string[] = ['view'],
    limit: AccessSummary['limit'] = null,
  ): AccessSummary => ({
    scope,
    caps: caps as AccessSummary['caps'],
    limit,
  });

  it('says nothing when the scope did not change, or the user may change the new scope', () => {
    expect(scopeAnnouncement(at('region:r1'), at('region:r1'), regions, tr, nameOf)).toBeNull();
    expect(
      scopeAnnouncement(at('body'), at('region:r1', ['view', 'edit']), regions, tr, nameOf),
    ).toBeNull();
    expect(
      scopeAnnouncement(at('body'), at('region:r1', ['view', 'suggest']), regions, tr, nameOf),
    ).toBeNull();
  });

  it('tells the user a titled read-only region and who can edit it', () => {
    expect(scopeAnnouncement(at('body'), at('region:r1'), regions, tr, nameOf)).toBe(
      'Clause 4: you cannot edit this part. It can be edited by Ada.',
    );
  });

  it('says a hidden part is hidden and names nobody in it', () => {
    expect(
      scopeAnnouncement(at('body'), at('region:r2', ['view'], 'hidden'), regions, tr, nameOf),
    ).toBe(tr.t('reason.access.hidden'));
  });
});
