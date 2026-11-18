/**
 * Applying routing to the participants of a workflow (12 §5.1, §6.1; FRW-037 criteria 1 and 2).
 * Pure: `@docedit/rules` says which routes apply (`evaluateRouting`) and what they ask for; this
 * module changes the participant list, and nothing else. The evaluation points, the control commit,
 * the webhooks and the `wf.changed` push are the document service's (docs/adr/0405-w4-FRW-037-routing.md,
 * proposed).
 *
 * - `addParticipant { role, order }` adds one participant who holds the role, of kind `approver`, at
 *   that order, with the identifier `route<route index>_<role>` and no person (`sub`): the host has
 *   not said who it is. The identifier is the same every time, so a second evaluation adds nobody.
 *   The order rules of `order.ts` then decide who is active: a participant added below the order
 *   that is active now becomes the active one.
 * - `skipParticipant { role }` skips every participant who holds the role and has not completed. A
 *   skipped participant is not active and does not hold the workflow back (`mustAct`, order.ts).
 * - A participant is never un-added or un-skipped: once an effect has applied it stands, even if the
 *   condition is false at a later evaluation. The participant who is completing now is never skipped.
 */
import {
  compileRouting,
  evaluateRouting,
  readDocument,
  type RoutingAction,
  type RuleProblem,
} from '@docedit/rules';
import { DEFAULT_RULE_BUDGET } from '../room/rules.ts';
import type { ParticipantKind } from './lifecycle.ts';

/** The members of a participant that routing reads and writes; the stored resource has more. */
export interface RoutedParticipant {
  readonly id: string;
  readonly roles: readonly string[];
  readonly kind: ParticipantKind;
  readonly order: number;
  readonly state?: string;
  /** The route that skipped the participant (its index in `routing`). */
  readonly skippedBy?: number;
  /** The route that added the participant (its index in `routing`). */
  readonly addedBy?: number;
}

/** The kind of a participant a route adds (proposed, ADR 0405). */
export const ROUTED_KIND: ParticipantKind = 'approver';

/** The identifier of the participant that route `route` adds for `role`. */
export function routedParticipantId(route: number, role: string): string {
  return `route${route}_${role}`;
}

export interface RoutingApplied<P extends RoutedParticipant> {
  /**
   * The list after the actions: the participants in the order given, then the added ones. An added
   * participant holds only the members of `RoutedParticipant`, so `P` must allow that.
   */
  readonly participants: readonly P[];
  /** The identifiers of the participants this call added. */
  readonly added: readonly string[];
  /** The identifiers of the participants this call skipped. */
  readonly skipped: readonly string[];
  /** Whether anything changed. */
  readonly changed: boolean;
}

/**
 * Applies the actions of the routes that apply, in route order and then effect order. A participant
 * named in `except` is never skipped (the one who is completing).
 */
export function applyRouting<P extends RoutedParticipant>(
  participants: readonly P[],
  actions: readonly RoutingAction[],
  except: readonly string[] = [],
): RoutingApplied<P> {
  let list: P[] = [...participants];
  const added: string[] = [];
  const skipped: string[] = [];
  for (const action of actions) {
    if (action.k === 'addParticipant') {
      const id = routedParticipantId(action.route, action.role);
      if (list.some((p) => p.id === id)) continue;
      const made: RoutedParticipant = {
        id,
        roles: [action.role],
        kind: ROUTED_KIND,
        order: action.order,
        addedBy: action.route,
      };
      list.push(made as P);
      added.push(id);
      continue;
    }
    list = list.map((p) => {
      if (!p.roles.includes(action.role)) return p;
      if (p.state === 'completed' || p.skippedBy !== undefined || except.includes(p.id)) return p;
      skipped.push(p.id);
      return { ...p, state: 'skipped', skippedBy: action.route };
    });
  }
  return { participants: list, added, skipped, changed: added.length + skipped.length > 0 };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The roles that routes may add, read from a `routing` list as written. Shapes are not checked here
 * (`compileRouting` does that); anything that is not a route with an `addParticipant` role is passed
 * over. The send checklist uses it: a role that only a route can fill needs no holder at the send.
 */
export function rolesAddedByRouting(routing: unknown): string[] {
  if (!Array.isArray(routing)) return [];
  const roles = new Set<string>();
  for (const route of routing) {
    if (!isObj(route) || !Array.isArray(route['then'])) continue;
    for (const effect of route['then']) {
      const add = isObj(effect) ? effect['addParticipant'] : undefined;
      if (isObj(add) && typeof add['role'] === 'string') roles.add(add['role']);
    }
  }
  return [...roles];
}

export type RoutingCheck =
  { readonly ok: true } | { readonly ok: false; readonly problems: readonly RuleProblem[] };

/**
 * The save-time check of a workflow's `routing` list (FRW-037 criterion 3), against a document in
 * its JSON form (an envelope or the `doc` node): the field keys and roles it names must exist and
 * each condition must be boolean. A missing list is valid. Every problem is returned, with its JSON
 * Pointer under `/routing`.
 */
export function checkRoutingOfDocument(routing: unknown, document: unknown): RoutingCheck {
  if (routing === undefined) return { ok: true };
  const d = readDocument(document);
  const compiled = compileRouting(routing, { fields: d.fields, roles: d.roles }, '/routing');
  return compiled.ok ? { ok: true } : { ok: false, problems: compiled.problems };
}

/** What `routeParticipants` needs besides the participants. */
export interface RoutingFacts {
  /** The workflow's `routing` list as stored. */
  readonly routing: readonly unknown[] | undefined;
  /** The document, whole, in its JSON form (an envelope or the `doc` node). */
  readonly document: unknown;
  /** The server's clock, ISO 8601 UTC, and the workflow's time zone (for `{ "now": "date" }`). */
  readonly instant: string;
  readonly timeZone: string;
  readonly budget?: number | undefined;
  /** Participants that routing must not skip: the one who is completing. */
  readonly except?: readonly string[] | undefined;
}

export type RoutedStep<P extends RoutedParticipant> =
  | ({ readonly ok: true } & RoutingApplied<P>)
  | {
      readonly ok: false;
      readonly code: 'rules_invalid';
      readonly problems: readonly RuleProblem[];
    }
  | { readonly ok: false; readonly code: 'budget_exceeded' };

/**
 * Evaluates the routes against the document's field values and applies the effects of those that
 * apply (FRW-037 criteria 1 and 2). Routing has no evaluating participant, so it evaluates with no
 * roles. A route whose condition is unknown or fails to evaluate does not apply (rules/src/routing.ts);
 * a budget that runs out stops the evaluation with `budget_exceeded` and nothing is applied.
 */
export function routeParticipants<P extends RoutedParticipant>(
  participants: readonly P[],
  facts: RoutingFacts,
): RoutedStep<P> {
  const none: RoutedStep<P> = { ok: true, participants, added: [], skipped: [], changed: false };
  if (facts.routing === undefined || facts.routing.length === 0) return none;
  const d = readDocument(facts.document);
  const compiled = compileRouting(facts.routing, { fields: d.fields, roles: d.roles }, '/routing');
  if (!compiled.ok) return { ok: false, code: 'rules_invalid', problems: compiled.problems };
  const evaluated = evaluateRouting(compiled.routing, d.values, {
    roles: [],
    now: { instant: facts.instant, timeZone: facts.timeZone },
    budget: facts.budget ?? DEFAULT_RULE_BUDGET,
  });
  if (!evaluated.ok) return { ok: false, code: 'budget_exceeded' };
  const applied = applyRouting(participants, evaluated.actions, facts.except ?? []);
  return applied.changed ? { ok: true, ...applied } : none;
}
