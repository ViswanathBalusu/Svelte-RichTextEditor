// FRW-007 criterion 5 (12 §4.1; 05 §5.5): the `access` object of `ch.opened` and `perm.changed`
// carries `fill: { participant, roles, active }`, lists no fields, and is null for a connection with
// no fill rights. The room bridge builds both messages with `toAccess` (room-bridge.ts), so this
// test drives that translation with the authority's access computation. Node.js only.
// Lane U-FRW-001-018.
import { computeAccess, type Connection, type PermissionState } from '@docedit/authority';
import { describe, expect, it } from 'vitest';
import { toAccess } from './translate.ts';

const NOW = 1_000_000;

const perms = (documentState: 'active' | 'locked' = 'active'): PermissionState =>
  ({
    revision: 3,
    grants: [],
    regionStates: new Map(),
    leases: [],
    documentState,
    workflowActive: true,
  }) as unknown as PermissionState;

const conn = (over: Partial<Connection> = {}): Connection =>
  ({
    sub: 'lena',
    session: 's-lena',
    role: 'filler',
    groups: [],
    participantRoles: ['landlord'],
    participantActive: true,
    participant: 'p-landlord',
    ...over,
  }) as Connection;

/** The DEP `access` object of a connection, as the bridge sends it in `ch.opened`. */
function wire(c: Connection, p: PermissionState = perms()) {
  return toAccess(computeAccess(c, [], p, NOW), c, p, [], p.revision, 42);
}

describe('FRW-007 criterion 5: the fill member of the access object', () => {
  it('carries participant, roles and active, and nothing else', () => {
    const out = wire(conn());
    expect(out.fill).toEqual({ participant: 'p-landlord', roles: ['landlord'], active: true });
    expect(Object.keys(out.fill!).sort()).toEqual(['active', 'participant', 'roles']);
  });

  it('lists no fields, whatever the fields of the document are', () => {
    const out = wire(conn());
    expect(JSON.stringify(out.fill)).not.toMatch(/field/);
  });

  it('names the user when the token carries no wfp claim (DEP participant is a user then)', () => {
    const c = conn();
    delete c.participant;
    const out = wire(c);
    expect(out.fill?.participant).toBe('lena');
    expect(out.fill?.roles).toEqual(['landlord']);
  });

  it('reports an inactive participant as not active, with the roles it holds', () => {
    const out = wire(conn({ participantActive: false }));
    expect(out.fill).toEqual({ participant: 'p-landlord', roles: ['landlord'], active: false });
  });

  it('is null for a connection with no fill rights (no fill role)', () => {
    expect(wire(conn({ role: 'viewer', participantRoles: [] })).fill).toBeNull();
  });

  it('is null for a fill-capable connection that holds no role placeholder', () => {
    expect(wire(conn({ participantRoles: [] })).fill).toBeNull();
  });

  it('is null when the document is locked for a connection without workflow fill', () => {
    const p = { ...perms('locked'), workflowActive: false } as unknown as PermissionState;
    expect(wire(conn(), p).fill).toBeNull();
  });
});
