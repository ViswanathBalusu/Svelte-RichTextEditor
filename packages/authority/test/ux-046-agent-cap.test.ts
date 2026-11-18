// UX-044 and UX-046 (lane w3): the cap of an agent connection (07 section 4; ADR 0234 A3; owner
// decisions 119 and 172). Node.js only. An agent holds, in every scope, the capabilities its user
// holds there, limited to view, comment and suggest. It never holds edit, fill, structure or manage.
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import type { Connection } from '../src/permissions/model.ts';
import { USERS, basePermissions } from './fixtures.ts';

const REGIONS = [
  { id: 'rLegal000000000B', policy: 'restricted' as const },
  { id: 'rNotes00000000C', policy: 'inherit' as const },
];
const NOW = 1_770_000_000_000;

const as = (user: Connection, agent?: string): Connection =>
  agent === undefined ? user : { ...user, agent };
const sorted = (caps: ReadonlySet<string>) => [...caps].sort();

describe('the capabilities of an agent connection (UX-044 criterion 3; UX-046 criterion 5)', () => {
  it('gives an editor’s agent view, comment and suggest in every scope, and no more', () => {
    const user = computeAccess(as(USERS.carol), REGIONS, basePermissions(), NOW);
    const agent = computeAccess(
      as(USERS.carol, 'assistant:drafting'),
      REGIONS,
      basePermissions(),
      NOW,
    );
    expect(user.body.has('edit')).toBe(true);
    expect(sorted(agent.body)).toEqual(['comment', 'suggest', 'view']);
    expect(agent.docRole.has('structure')).toBe(false);
    expect(agent.docRole.has('manage')).toBe(false);
    expect(agent.structureScopes.has('edit')).toBe(false);
    expect(agent.newRegion.has('edit')).toBe(false);
    for (const caps of agent.regions.values()) {
      expect(caps.has('edit')).toBe(false);
      expect(caps.has('fill')).toBe(false);
    }
    expect(agent.fill.allowed).toBe(false);
  });

  it('never gives the agent a capability its user lacks, in any scope (property over the fixture users)', () => {
    for (const user of Object.values(USERS)) {
      const u = computeAccess(as(user), REGIONS, basePermissions(), NOW);
      const a = computeAccess(as(user, 'assistant:drafting'), REGIONS, basePermissions(), NOW);
      const pairs: Array<[ReadonlySet<string>, ReadonlySet<string>]> = [
        [a.body, u.body],
        [a.structureScopes, u.structureScopes],
        [a.newRegion, u.newRegion],
        ...[...a.regions].map(([id, caps]): [ReadonlySet<string>, ReadonlySet<string>] => [
          caps,
          u.regions.get(id)!,
        ]),
      ];
      for (const [agentCaps, userCaps] of pairs) {
        for (const cap of agentCaps) {
          expect(userCaps.has(cap), `${user.sub} agent holds ${cap}`).toBe(true);
          expect(['view', 'comment', 'suggest']).toContain(cap);
        }
      }
    }
  });

  it('leaves a connection without an agent as it was', () => {
    const a = computeAccess(as(USERS.carol), REGIONS, basePermissions(), NOW);
    expect(a.body.has('edit')).toBe(true);
    expect(a.docRole.has('structure')).toBe(true);
  });
});
