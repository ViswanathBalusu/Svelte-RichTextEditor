/**
 * Scenarios and profiles (05 §11). A profile maps to what a server announces (a feature, or its
 * mode); a scenario is one black-box check with a stable identifier. Every scenario declares what it
 * exercises, so that the check of PRO-117 can tell which message types, payload members, routes,
 * close codes, error codes and notification types have a scenario, without running one.
 */
import type { ScenarioContext } from './context.ts';

/** What a scenario exercises (PRO-117; 05 §1 rule 7). */
export interface Coverage {
  /** Message types sent or received and checked, for example `ch.open`. */
  readonly messages?: readonly string[];
  /**
   * Optional payload members, as `<type>.<member>` (for example `ch.open.resume`). Required
   * members are covered by every received message: the kit validates each against its schema.
   */
  readonly fields?: readonly string[];
  /** Operations, as `METHOD /path` with the path of 05 §6.2 (for example `GET /documents/{id}`). */
  readonly operations?: readonly string[];
  /** Close codes of 05 §5.7 the scenario provokes and checks. */
  readonly closeCodes?: readonly number[];
  /** Registry codes of 05 §5.8 the scenario provokes and checks. */
  readonly errors?: readonly string[];
  /** Notification types of 05 §5.6 the scenario checks. */
  readonly events?: readonly string[];
}

/** What a scenario needs beyond the bootstrap contract; without it the scenario is skipped. */
export interface Needs {
  /** The server's test-mode switch must be on (PRO-109). */
  readonly testMode?: boolean;
  /** An origin registered for the kit's tenant (CORS and `Origin` checks). */
  readonly origin?: boolean;
  /** Features the server must announce, beyond the profile's own. */
  readonly features?: readonly string[];
}

export interface ScenarioDef {
  /** Stable identifier, `<profile>.<name>`. */
  readonly id: string;
  readonly title: string;
  /** The sections of the specification it checks. */
  readonly spec: string;
  readonly covers: Coverage;
  readonly needs?: Needs;
  /** Overrides the run's scenario timeout (a scenario that waits for a server timer). */
  readonly timeoutMs?: number;
  /** The scenario runs for the fuzzing budget: its timeout is that budget plus a minute. */
  readonly budget?: 'fuzz';
  run(ctx: ScenarioContext): Promise<void>;
}

/** When a profile applies (05 §11: "a profile maps to the features a server may announce"). */
export type ProfileRequirement =
  /** Every server. */
  | { readonly kind: 'always' }
  /** Servers in this mode (05 §2, §9). */
  | { readonly kind: 'mode'; readonly mode: 'authority' | 'relay' }
  /** Servers that announce every one of these features. */
  | { readonly kind: 'features'; readonly features: readonly string[] }
  /** A run that is given an authority service address (05 §10): it is not reached over DEP. */
  | { readonly kind: 'authority-service' };

export interface ProfileDef {
  readonly id: string;
  readonly title: string;
  readonly spec: string;
  /** The stories that deliver the profile. */
  readonly stories: readonly string[];
  readonly requires: ProfileRequirement;
  readonly scenarios: readonly ScenarioDef[];
  /** Why the profile has no scenarios yet, for a profile of a later phase. */
  readonly pending?: string;
}

/** Builds a scenario; the identifier is prefixed with the profile's. */
export function scenario(
  profile: string,
  def: Omit<ScenarioDef, 'id'> & { id: string },
): ScenarioDef {
  return { ...def, id: `${profile}.${def.id}` };
}
