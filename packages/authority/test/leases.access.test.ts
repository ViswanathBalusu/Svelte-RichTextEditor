// Check-out leases seen through access (07 §10; PRM-043 criterion 4): while Alice holds a lease on
// a region, Bob (an owner) has at most `view` and `comment` there, `access.leases` names the holder
// and the expiry, and Bob's commit in the region is refused with `permission_denied`.
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import type { Connection, PermissionState } from '../src/permissions/model.ts';
import { regionInfos } from '../src/permissions/visibility.ts';
import { stepsToJson } from '../src/steps.ts';
import { USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';
import { commitId, messages, rejection, roomWith } from './permission-fixtures.ts';

const TERMS = 'rTerms000000000A';
const NOW = 1_770_700_000_000;
const EXPIRES = NOW + 300_000;
const OWEN: Connection = {
  sub: 'owen',
  session: 's-owen',
  role: 'owner',
  groups: [],
  participantRoles: [],
  participantActive: false,
};

const leased = (extra: Partial<PermissionState> = {}): PermissionState => ({
  ...basePermissions(),
  leases: [{ region: TERMS, holder: 'alice', expiresAt: EXPIRES, id: 'l1', acquiredAt: NOW }],
  ...extra,
});

const access = (conn: Connection, perms: PermissionState, now = NOW) =>
  computeAccess(conn, regionInfos(baseDoc()), perms, now);

const typeAt = (id: string, text: string) => {
  const doc = baseDoc();
  const pos = posInside(doc, id);
  return new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0));
};

describe('a lease limits everyone but its holder in the region (PRM-043 criterion 4)', () => {
  it('caps an owner who is not the holder at view and comment in the leased region', () => {
    const a = access(OWEN, leased());
    expect([...a.regions.get(TERMS)!].sort()).toEqual(['comment', 'view']);
    // The owner keeps the document-level capabilities, which a region lease does not take away.
    expect(a.docRole.has('manage')).toBe(true);
  });

  it('leaves the holder with the capabilities her role and grants give her', () => {
    const a = access(USERS.alice, leased());
    expect(a.regions.get(TERMS)!.has('edit')).toBe(true);
  });

  it('shows access.leases with the holder and the expiry, and no lease that has run out', () => {
    expect(access(OWEN, leased()).leases).toEqual([
      { region: TERMS, holder: 'alice', expiresAt: EXPIRES, id: 'l1', acquiredAt: NOW },
    ]);
    expect(access(OWEN, leased(), EXPIRES).leases).toEqual([]);
  });

  it('refuses the owner a commit in the leased region with permission_denied, and names no other region', () => {
    const perms = leased();
    const room = roomWith(baseDoc(), perms, () => NOW);
    const opened = messages(room.open('o1', OWEN), 'o1').find((m) => m.t === 'ch.opened');
    expect(opened?.t === 'ch.opened' && opened.access.leases.map((l) => l.holder)).toEqual([
      'alice',
    ]);
    const fx = room.submit('o1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson([typeAt('pTerms000000001A', 'x')]),
    });
    expect(rejection(fx, 'o1')).toMatchObject({ code: 'permission_denied' });
  });
});
