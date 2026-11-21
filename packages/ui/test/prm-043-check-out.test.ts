/**
 * Check-out of a region in the permissions pane (PRM-043 criterion 7, lane w5): what the pane offers
 * for one region follows from the region list, the user's access and the leases the session holds,
 * and the pane shows the control only when the core has a leases service.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AccessObject, HeldLease, RegionSummary } from '../src/core-api.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { checkOutState, leaseFailureKey } from '../src/shell/leases.ts';

function region(over: Partial<RegionSummary> = {}): RegionSummary {
  return {
    id: 'r1',
    title: 'Terms',
    policy: 'inherit',
    order: 0,
    state: 'draft',
    editors: { roles: ['editor', 'owner'], principals: [] },
    ...over,
  };
}

const access = (scopes: Record<string, readonly string[]>): AccessObject => ({
  rev: 1,
  docRole: 'editor',
  caps: ['view', 'comment', 'suggest', 'edit'],
  scopes,
});
const CAN_EDIT = access({ 'region:r1': ['view', 'comment', 'suggest', 'edit'] });
const MINE: HeldLease = { region: 'r1', holder: 'alice', expiresAt: '2026-11-18T10:05:00.000Z' };

describe('what the pane offers for a region (PRM-043)', () => {
  it('offers check-out to a user who can edit a region nobody holds', () => {
    expect(checkOutState(region(), CAN_EDIT, [])).toEqual({ kind: 'offer' });
  });

  it('says why when the user cannot check a region out', () => {
    expect(checkOutState(region(), access({ 'region:r1': ['view'] }), [])).toEqual({
      kind: 'blocked',
      reason: 'lease.noEdit',
    });
    expect(checkOutState(region(), undefined, [])).toEqual({
      kind: 'blocked',
      reason: 'lease.noEdit',
    });
    expect(checkOutState(region({ state: 'approved' }), CAN_EDIT, [])).toEqual({
      kind: 'blocked',
      reason: 'lease.approved',
    });
  });

  it('offers release to the holder, and only names the holder to everyone else', () => {
    const held = region({
      editors: { roles: [], principals: [], leasedTo: 'alice' },
    });
    expect(checkOutState(held, CAN_EDIT, [MINE])).toEqual({ kind: 'mine' });
    expect(checkOutState(held, CAN_EDIT, [])).toEqual({ kind: 'other', holder: 'alice' });
  });

  it('does not treat a lease that someone else now holds as the user is', () => {
    const taken = region({ editors: { roles: [], principals: [], leasedTo: 'bob' } });
    expect(checkOutState(taken, CAN_EDIT, [MINE])).toEqual({ kind: 'other', holder: 'bob' });
  });

  it('shows nothing for a region hidden from this reader (ADR 0019)', () => {
    expect(checkOutState(region({ title: null }), CAN_EDIT, [])).toEqual({ kind: 'none' });
  });
});

describe('a refused check-out is shown in words', () => {
  it('names a conflict, a refusal and anything else', () => {
    expect(leaseFailureKey({ code: 'conflict' })).toBe('lease.conflict');
    expect(leaseFailureKey({ code: 'forbidden' })).toBe('lease.forbidden');
    expect(leaseFailureKey({ code: 'unavailable' })).toBe('lease.failed');
    expect(leaseFailureKey(new Error('x'))).toBe('lease.failed');
    expect(leaseFailureKey(null)).toBe('lease.failed');
  });

  it('has a string for every key the pane can show', () => {
    for (const key of [
      'lease.heading',
      'lease.help',
      'lease.checkOut',
      'lease.release',
      'lease.mine',
      'lease.other',
      'lease.approved',
      'lease.noEdit',
      'lease.taken',
      'lease.released',
      'lease.conflict',
      'lease.forbidden',
      'lease.failed',
    ])
      expect(Object.hasOwn(EN_GB, key), key).toBe(true);
  });
});

describe('the pane shows check-out only when the core has a leases service (criterion 7)', () => {
  const pane = readFileSync(
    fileURLToPath(new URL('../src/panes/PermissionsPane.svelte', import.meta.url)),
    'utf8',
  );

  it('reads the service from the core and builds the state from it', () => {
    expect(pane).toContain('core.leases ? live(core.leases.held) : null');
    expect(pane).toMatch(/selected && core\.leases\s*\?\s*checkOutState\(/);
  });

  it('draws the control only for a state that has one', () => {
    expect(pane).toContain("checkOut && checkOut.kind !== 'none'");
    // The two buttons call the service; nothing else does.
    expect(pane).toContain('core.leases.acquire(region)');
    expect(pane).toContain('core.leases.release(region)');
  });
});
