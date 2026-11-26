/**
 * The lock indicator of an approved region (PRM-048 criterion 2, lane V-PRM-035-051): it says the
 * region is approved and that an owner must change its state before it can be edited. Other
 * regions keep the who-can-edit sentence.
 */
import { describe, expect, it } from 'vitest';
import type { AccessObject, RegionSummary } from '../src/core-api.ts';
import { sourceTranslator } from '../src/i18n/strings.ts';
import { regionLabels, whoCanEdit } from '../src/shell/regions.ts';

const tr = sourceTranslator();
const nameOf = (principal: string): string => principal;

function region(over: Partial<RegionSummary> & { id: string }): RegionSummary {
  return { title: 'Clause 4', policy: 'inherit', order: 0, state: 'draft', ...over };
}

function access(scopes: Record<string, readonly string[]>): AccessObject {
  return { rev: 1, docRole: 'viewer', caps: ['view'], scopes };
}

describe('lock indicator of an approved region (PRM-048, criterion 2)', () => {
  it('says the region is approved and that an owner must change its state first', () => {
    const labels = regionLabels(
      [region({ id: 'r1', state: 'approved' })],
      access({ 'region:r1': ['view'] }),
      tr,
      nameOf,
    );
    expect(labels['r1']?.description).toBe(
      'It is approved. An owner must change its state before it can be edited.',
    );
    expect(labels['r1']?.indicator).toBe('Read-only');
  });

  it('keeps the who-can-edit sentence for a draft or in-review region', () => {
    const labels = regionLabels(
      [
        region({ id: 'r1', state: 'draft', editors: { roles: [], principals: [] } }),
        region({ id: 'r2', state: 'in_review', editors: { roles: [], principals: [] } }),
      ],
      access({}),
      tr,
      nameOf,
    );
    expect(labels['r1']?.description).toBe('Nobody can edit it at the moment.');
    expect(labels['r2']?.description).toBe('Nobody can edit it at the moment.');
  });

  it('gives no indicator to an approved region the user may edit (an owner who has edit)', () => {
    const labels = regionLabels(
      [region({ id: 'r1', state: 'approved' })],
      access({ 'region:r1': ['view', 'edit'] }),
      tr,
      nameOf,
    );
    expect(labels).toEqual({});
  });
});

describe('lock indicator of a leased region (PRM-048, criterion 3)', () => {
  const until = '2026-11-18T10:05:00.000Z';
  const leased = (over: Partial<RegionSummary['editors'] & object> = {}) =>
    region({
      id: 'r1',
      editors: { roles: [], principals: [], leasedTo: 'bob', leaseExpiresAt: until, ...over },
    });

  it('names the holder and when the lease expires', () => {
    const labels = regionLabels([leased()], access({ 'region:r1': ['view'] }), tr, nameOf);
    const when = tr.date(new Date(until), { dateStyle: 'medium', timeStyle: 'short' });
    expect(labels['r1']?.description).toBe(
      `user:bob is editing it at the moment. The lease expires ${when}.`,
    );
  });

  it('names the holder alone when the service gave no expiry or an unreadable one', () => {
    for (const leaseExpiresAt of [undefined, 'soon']) {
      const editors = { roles: [], principals: [], leasedTo: 'bob' } as const;
      const r = region({
        id: 'r1',
        editors: leaseExpiresAt === undefined ? editors : { ...editors, leaseExpiresAt },
      });
      const labels = regionLabels([r], access({}), tr, nameOf);
      expect(labels['r1']?.description).toBe('user:bob is editing it at the moment.');
    }
  });

  it('says the same in the announcement when the caret enters the region', () => {
    const when = tr.date(new Date(until), { dateStyle: 'medium', timeStyle: 'short' });
    expect(whoCanEdit(leased(), tr, nameOf)).toContain(when);
  });
});
