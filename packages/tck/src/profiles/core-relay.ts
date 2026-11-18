/**
 * The `core-relay` profile (PRO-124; 05 §9, §2; 04 §14): what a relay announces. A relay stores and
 * orders commits and relays them, and nothing more, so it never announces a feature that needs the
 * document model. The kit selects this profile for a server whose discovery says `mode: "relay"`
 * and not the profiles that need document semantics (`PROFILES` in `index.ts`).
 *
 * Scenarios that submit commits to a relay (a commit whose `base` is not the head is rejected with
 * `stale_base`; commits at the head are stored and relayed unchanged) are not here: no relay server
 * that speaks DEP exists to run them against (PRO-124 Notes).
 */
import { check, equal, includes, oneOf } from '../assert.ts';
import { shapeViolations } from '../context.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';

const s = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('core-relay', def);

/** The features a relay never announces (05 §2; 04 §14). */
export const RELAY_NEVER_ANNOUNCES = ['regions', 'suggest-enforced', 'fields'] as const;

export const CORE_RELAY: ScenarioDef[] = [
  s({
    id: 'discovery.mode-and-features',
    title: 'a relay says so in discovery and announces none of regions, suggest-enforced, fields',
    spec: '05 §2, §9; 04 §14',
    covers: { operations: ['GET /.well-known/dep'] },
    async run(ctx) {
      const res = await ctx.target.http.request('GET', ctx.target.discoveryUrl);
      equal(res.status, 200, 'GET /.well-known/dep without a credential (D66)');
      const violations = shapeViolations('Discovery', res.json);
      check(
        violations.length === 0,
        'discovery matches the published schema',
        'no violations',
        violations,
      );
      const d = ctx.target.discovery;
      oneOf(d.mode, ['relay'], 'mode');
      for (const f of RELAY_NEVER_ANNOUNCES)
        check(
          !d.features.includes(f),
          `a relay never announces ${f} (05 §2, §9)`,
          'absent',
          d.features,
        );
      includes(d.versions, '1.0', 'versions');
    },
  }),
];

export const CORE_RELAY_PROFILE: ProfileDef = {
  id: 'core-relay',
  title: 'The core profile for relays',
  spec: '05 §9; 04 §14',
  stories: ['PRO-124'],
  requires: { kind: 'mode', mode: 'relay' },
  scenarios: CORE_RELAY,
};
