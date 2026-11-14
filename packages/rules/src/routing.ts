/**
 * Routing rules of the workflow resource (12 §5.1, §6.1; FRW-037). A route is
 * `{ "when": <condition>, "then": [<routing effect>, ...] }`. The condition is an expression of the
 * rules language and is checked like a rule's condition: its field keys and roles exist, and it is
 * boolean. The routing effects are `addParticipant` (`{ "role", "order" }`) and `skipParticipant`
 * (`{ "role" }`); they are valid only here, never in a `rule_def` (routing_effect in language.ts).
 *
 * - `compileRouting` checks a workflow's routes when the workflow is saved and returns every
 *   problem with its path (FRW-037 criterion 3). It is the validator; the save that calls it belongs
 *   to the workflow service.
 * - `evaluateRouting` says which routes apply for the field values and which participants they add
 *   or skip. It does not add or skip anyone: activation, ordering, the control commit and the
 *   webhooks belong to the workflow (FRW-037 criteria 1, 2 and 4).
 *
 * Decisions taken here, each to be confirmed (docs/adr/0159-rules-3-backlog-batch.md):
 * - Every route is evaluated, in the order written; there is no first match.
 * - A condition that is null (unknown) does not apply. A condition whose evaluation fails, for
 *   example a stored value that no longer checks, is reported as its error and does not apply.
 *   Nothing is applied silently on an error.
 * - `order` is a positive integer. The spec's example uses 2 and gives no grammar.
 * - The routes of one workflow are capped at `LIMITS.rules`, the cap on rules of a document.
 * - Routing evaluates with the roles the caller gives in the context. Routing has no evaluating
 *   participant, so the usual context is `roles: []`.
 */
import { DEFINITION_ID_PATTERN } from './cdm.ts';
import { type EvaluationContext, type ValueMap, evaluateExpression } from './evaluate.ts';
import type { FieldInfo } from './fields.ts';
import { type JsonObject, isObject, pointer } from './json.ts';
import {
  FIELD_EFFECTS,
  type RuleProblem,
  type RuntimeError,
  compileExpression,
} from './language.ts';
import { LIMITS } from './limits.ts';

export interface RoutingEnvironment {
  fields: readonly FieldInfo[];
  /** The document's `role_def` identifiers. A route may name only these roles. */
  roles: readonly string[];
}

export type RoutingEffect =
  | { k: 'addParticipant'; role: string; order: number; path: string }
  | { k: 'skipParticipant'; role: string; path: string };

export interface CompiledRoute {
  /** Position in the workflow's `routing` list; routes are evaluated in this order. */
  index: number;
  path: string;
  /** The condition as written. It was checked by compileRouting and is evaluated by evaluateExpression. */
  when: unknown;
  then: readonly RoutingEffect[];
}

export interface RoutingSet {
  readonly routes: readonly CompiledRoute[];
  readonly fields: readonly FieldInfo[];
  readonly roles: readonly string[];
}

export type RoutingCompileResult =
  { ok: true; routing: RoutingSet; problems: [] } | { ok: false; problems: RuleProblem[] };

type Add = (code: RuleProblem['code'], at: string, message: string) => void;

const idRe = new RegExp(DEFINITION_ID_PATTERN);

/** True when the object has exactly the members named, and no others. */
const hasMembers = (o: JsonObject, names: readonly string[]): boolean =>
  Object.keys(o).sort().join(',') === [...names].sort().join(',');

function parseRoutingEffect(
  json: unknown,
  path: string,
  roles: ReadonlySet<string>,
  add: Add,
): RoutingEffect | null {
  if (!isObject(json) || Object.keys(json).length !== 1) {
    add('bad_shape', path, 'a routing effect is an object with one member naming the effect');
    return null;
  }
  const name = Object.keys(json)[0]!;
  if (name !== 'addParticipant' && name !== 'skipParticipant') {
    add(
      'unknown_effect',
      path,
      (FIELD_EFFECTS as readonly string[]).includes(name)
        ? `${name} is a field effect; routing takes addParticipant or skipParticipant (12 §5.1)`
        : `"${name}" is not a routing effect; routing takes addParticipant or skipParticipant`,
    );
    return null;
  }
  const arg = json[name];
  const at = pointer(path, name);
  const shape = name === 'addParticipant' ? ['order', 'role'] : ['role'];
  if (!isObject(arg) || !hasMembers(arg, shape)) {
    add(
      'bad_shape',
      at,
      name === 'addParticipant'
        ? 'addParticipant is { "role": identifier, "order": positive integer }'
        : 'skipParticipant is { "role": identifier }',
    );
    return null;
  }
  const role = arg['role'];
  if (typeof role !== 'string' || !idRe.test(role)) {
    add('bad_shape', pointer(at, 'role'), 'a role is a role identifier, such as "role_approver"');
    return null;
  }
  if (!roles.has(role)) {
    add('unknown_role', pointer(at, 'role'), `no role_def has the identifier "${role}"`);
    return null;
  }
  if (name === 'skipParticipant') return { k: 'skipParticipant', role, path };
  const order = arg['order'];
  if (typeof order !== 'number' || !Number.isSafeInteger(order) || order < 1) {
    add(
      'bad_shape',
      pointer(at, 'order'),
      'order is a positive integer, the place the participant takes',
    );
    return null;
  }
  return { k: 'addParticipant', role, order, path };
}

/**
 * Checks a workflow's `routing` list (FRW-037 criterion 3): each route's condition against the
 * fields and roles of the document, and each routing effect's shape and role. Returns every problem
 * with its JSON Pointer, under `path`.
 */
export function compileRouting(
  json: unknown,
  env: RoutingEnvironment,
  path = '',
): RoutingCompileResult {
  const problems: RuleProblem[] = [];
  const add: Add = (code, at, message) => {
    problems.push({ code, path: at, message });
  };
  if (!Array.isArray(json)) {
    add('bad_shape', path, 'routing is a list of routes');
    return { ok: false, problems };
  }
  if (json.length > LIMITS.rules)
    add('too_many_rules', path, `a workflow has at most ${LIMITS.rules} routes`);
  const roles = new Set(env.roles);
  const routes: CompiledRoute[] = [];
  json.forEach((item: unknown, index: number) => {
    const at = pointer(path, index);
    if (!isObject(item) || !hasMembers(item, ['then', 'when'])) {
      add('bad_shape', at, 'a route is { "when": condition, "then": [routing effects] }');
      return;
    }
    const before = problems.length;
    const when = compileExpression(
      item['when'],
      { fields: env.fields, roles: env.roles },
      pointer(at, 'when'),
    );
    if (!when.ok) problems.push(...when.problems);
    else if (when.expr.ty !== 'boolean')
      add(
        'type_mismatch',
        pointer(at, 'when'),
        `a routing condition is boolean, not ${when.expr.ty}`,
      );
    const then: RoutingEffect[] = [];
    const list = item['then'];
    const thenAt = pointer(at, 'then');
    if (!Array.isArray(list)) add('bad_shape', thenAt, 'then is a list of routing effects');
    else
      list.forEach((effect: unknown, j: number) => {
        const e = parseRoutingEffect(effect, pointer(thenAt, j), roles, add);
        if (e) then.push(e);
      });
    if (problems.length === before) routes.push({ index, path: at, when: item['when'], then });
  });
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    routing: { routes, fields: env.fields, roles: env.roles },
    problems: [],
  };
}

/** The outcome of one route: it applies, it does not, or its condition failed. */
export type RouteOutcome = 'applies' | 'does_not_apply' | { error: RuntimeError };

export interface RouteResult {
  index: number;
  path: string;
  outcome: RouteOutcome;
}

/** What an applying route asks the workflow to do. `route` is the route's index. */
export type RoutingAction =
  | { k: 'addParticipant'; route: number; role: string; order: number }
  | { k: 'skipParticipant'; route: number; role: string };

export type RoutingEvaluation =
  | { ok: true; routes: RouteResult[]; actions: RoutingAction[]; steps: number }
  | { ok: false; code: 'budget_exceeded'; steps: number };

/**
 * Evaluates every route of a compiled routing set, in the order written, against the field values.
 * The actions are the effects of the routes that apply, in route order and then effect order.
 * `ctx.budget` bounds the steps of the whole evaluation (admission control, 04 §12).
 */
export function evaluateRouting(
  routing: RoutingSet,
  values: ValueMap,
  ctx: EvaluationContext,
): RoutingEvaluation {
  const routes: RouteResult[] = [];
  const actions: RoutingAction[] = [];
  const budget = ctx.budget ?? Infinity;
  let steps = 0;
  for (const route of routing.routes) {
    const r = evaluateExpression(route.when, {
      fields: routing.fields,
      roles: routing.roles,
      values,
      context: { ...ctx, budget: budget - steps },
    });
    if (!r.ok) {
      if ('code' in r) return { ok: false, code: r.code, steps: steps + r.steps };
      // The route was compiled against these same fields and roles, so it checks again.
      throw new Error(`routing ${route.path} was compiled but no longer checks`);
    }
    steps += r.steps;
    const res = r.result;
    if ('error' in res) {
      routes.push({ index: route.index, path: route.path, outcome: { error: res.error } });
      continue;
    }
    if (res.value !== true) {
      routes.push({ index: route.index, path: route.path, outcome: 'does_not_apply' });
      continue;
    }
    routes.push({ index: route.index, path: route.path, outcome: 'applies' });
    for (const e of route.then)
      actions.push(
        e.k === 'addParticipant'
          ? { k: 'addParticipant', route: route.index, role: e.role, order: e.order }
          : { k: 'skipParticipant', route: route.index, role: e.role },
      );
  }
  return { ok: true, routes, actions, steps };
}
