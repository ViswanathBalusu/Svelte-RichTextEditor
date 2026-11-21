/**
 * The three backend tiers and what each may announce (05 §9; 04 §14; PRO-101; ADR 0390, proposed).
 *
 * - Native: an authority of its own that passes the step-semantics and rules fixtures. It may
 *   announce every feature.
 * - Sidecar-backed: its own gateway, storage and control plane, with document semantics delegated to
 *   the authority service (05 §10). It may announce what the authority service supports.
 * - Relay: ordering and storage only. `mode` is `relay`; it announces none of the features the
 *   definition marks `relayForbidden`, and none that needs document semantics unless it is given an
 *   authority service for them.
 *
 * What a feature needs from the authority service is `AUTHORITY_SERVICE_NEEDS`. A feature that is
 * not listed does not depend on document semantics: it lives in the backend's own planes, or it is
 * relay-safe (the kit's `RELAY_SAFE`: presence, comments, webhooks, leases). The table is a proposal;
 * 05 §10 names the calls but not which feature uses which.
 */
import { DEP1_WIRE_BASE, type WireDefinition } from '../definition/wire.ts';
import type { Discovery } from '../generated/types.ts';

export type BackendTier = 'native' | 'sidecar' | 'relay';

/** The calls of the authority service interface (05 §10). */
export const AUTHORITY_SERVICE_CALLS = [
  'open',
  'applyCommit',
  'materialise',
  'mapRanges',
  'restoreSteps',
  'diff',
  'attribution',
  'migrate',
  'evaluateRules',
] as const;
export type AuthorityServiceCall = (typeof AUTHORITY_SERVICE_CALLS)[number];

/**
 * A call that 05 §10 does not define: reader projection (ADR 0019; second review SR-M6). No
 * authority service offers it yet, so no sidecar can announce the features that need it.
 */
export const PROJECTION_CALL = 'projection';
export type NeededCall = AuthorityServiceCall | typeof PROJECTION_CALL;

/** The calls each feature needs from the authority service (see the module comment). */
export const AUTHORITY_SERVICE_NEEDS: Readonly<Record<string, readonly NeededCall[]>> = {
  regions: ['open', 'applyCommit'],
  'suggest-enforced': ['open', 'applyCommit'],
  fields: ['open', 'applyCommit', 'evaluateRules'],
  rules: ['evaluateRules'],
  history: ['open', 'materialise', 'restoreSteps', 'diff', 'attribution'],
  exports: ['open', 'materialise'],
  assets: ['open', 'materialise'],
  'read-restrictions': ['open', 'applyCommit', PROJECTION_CALL],
};

/** The features a backend with these authority service calls can announce. */
export function featuresSupportedBy(
  calls: readonly string[],
  def: WireDefinition = DEP1_WIRE_BASE,
): string[] {
  const have = new Set(calls);
  return def.features
    .map((f) => f.name)
    .filter((name) => (AUTHORITY_SERVICE_NEEDS[name] ?? []).every((c) => have.has(c)));
}

export type TierProblemCode =
  'relay_mode' | 'relay_forbidden' | 'needs_authority_service' | 'sidecar_without_service';

export interface TierProblem {
  code: TierProblemCode;
  /** The feature, when the problem is about one. */
  feature?: string;
  message: string;
}

export interface TierInput {
  tier: BackendTier;
  /** What the backend announces in discovery. */
  discovery: Pick<Discovery, 'features'> & { mode?: Discovery['mode'] };
  /**
   * The authority service calls the backend can reach. A sidecar needs them; a relay may have them,
   * and then announces what they support.
   */
  authorityServiceCalls?: readonly string[];
}

/**
 * What a backend of this tier may not announce. Empty when the announcement is within the tier's
 * limits. Names that the definition does not list are not judged here (see
 * `featureNamespaceProblems`).
 */
export function tierProblems(
  input: TierInput,
  def: WireDefinition = DEP1_WIRE_BASE,
): TierProblem[] {
  const { tier, discovery } = input;
  const announced = [...new Set(discovery.features)];
  if (tier === 'native') return [];
  const problems: TierProblem[] = [];
  const calls = input.authorityServiceCalls;
  if (tier === 'sidecar' && (!calls || calls.length === 0))
    return [
      {
        code: 'sidecar_without_service',
        message: 'a sidecar-backed backend delegates document semantics to the authority service',
      },
    ];
  if (tier === 'relay' && discovery.mode !== 'relay')
    problems.push({ code: 'relay_mode', message: 'a relay announces `mode: "relay"` (05 §2)' });
  const forbidden = new Set(def.features.filter((f) => f.relayForbidden).map((f) => f.name));
  const have = new Set(calls ?? []);
  for (const feature of announced) {
    if (tier === 'relay' && forbidden.has(feature)) {
      problems.push({
        code: 'relay_forbidden',
        feature,
        message: `a relay may not announce \`${feature}\`: it cannot enforce it (05 §9)`,
      });
      continue;
    }
    const missing = (AUTHORITY_SERVICE_NEEDS[feature] ?? []).filter((c) => !have.has(c));
    if (missing.length)
      problems.push({
        code: 'needs_authority_service',
        feature,
        message: `\`${feature}\` needs the authority service call${missing.length > 1 ? 's' : ''} ${missing.join(', ')}, which this backend does not have (05 §9)`,
      });
  }
  return problems;
}
