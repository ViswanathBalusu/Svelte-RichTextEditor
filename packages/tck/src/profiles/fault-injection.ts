/**
 * The optional `fault-injection` profile (PRO-126; 05 §11; 04 §5; 06 §8). It covers what cannot be
 * seen from outside: durability before acknowledgement, fencing, the log rewind and the grants
 * revision. It applies only to a server that exposes test hooks. A server without them skips it, and
 * the README says what is then unproven (the hash chain and the audit trail).
 *
 * The feature name `test-hooks` is the kit's proposal (ADR 0219, proposed). DEP has no such feature
 * yet, and the hook interface is not specified, so the profile has no scenarios: the runner reports
 * it as skipped with the reason in `pending`.
 */
import type { ProfileDef } from '../scenario.ts';

/** The feature a server announces when it exposes the test hooks (ADR 0219; proposed). */
export const TEST_HOOKS_FEATURE = 'test-hooks';

export const FAULT_INJECTION: ProfileDef = {
  id: 'fault-injection',
  title: 'Durability, fencing, log rewind and the grants revision, through the test hooks',
  spec: '05 §11; 04 §5; 06 §8',
  stories: ['PRO-126'],
  requires: { kind: 'features', features: [TEST_HOOKS_FEATURE] },
  scenarios: [],
  pending: 'PRO-126: the hook interface is not specified yet, so no scenarios',
};
