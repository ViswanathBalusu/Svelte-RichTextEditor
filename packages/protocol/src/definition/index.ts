/**
 * The DEP definition of protocol version 1.0 (SPK-019): one source for the generated types, the
 * AsyncAPI, OpenAPI and JSON Schema artifacts, and the codec.
 */
import { CDM1 } from '@docedit/model/definition';
import { COMMON_SHAPES, ENGINES, PROTOCOL_VERSION, SUBPROTOCOL } from './common.ts';
import { DECISIONS, DECISION_IDS } from './decisions.ts';
import { CLOSE_CODES, ERRORS } from './errors.ts';
import { EVENT_SHAPES, NOTIFICATIONS, WEBHOOKS, webhookType } from './events.ts';
import type { DepDefinition, DepExtension } from './extension.ts';
import { FEATURES } from './features.ts';
import { FRW_EXTENSION } from './frw.ts';
import { GAPS, GAP_IDS } from './gaps.ts';
import { MESSAGES } from './messages.ts';
import { OPERATIONS, PATH_PARAMS, REST_SHAPES } from './resources.ts';
import type { Annotated, Shape } from './shapes.ts';

export * from './shapes.ts';
export * from './common.ts';
export * from './errors.ts';
export * from './features.ts';
export * from './events.ts';
export * from './gaps.ts';
export * from './decisions.ts';
export type { MessageDef, Direction } from './messages.ts';
export { MESSAGES } from './messages.ts';
export type { OperationDef, Method, Credential, SuccessDef } from './resources.ts';
export { OPERATIONS, PATH_PARAMS, REST_SHAPES } from './resources.ts';
export type { DepDefinition, DepExtension } from './extension.ts';
export { FRW_EXTENSION } from './frw.ts';

/** Builds the definition of protocol 1.0 from the core and the registered extensions. */
export function defineDep(extensions: readonly DepExtension[] = []): DepDefinition {
  return {
    version: PROTOCOL_VERSION,
    major: 1,
    subprotocol: SUBPROTOCOL,
    status: 'draft',
    engines: ENGINES,
    cdm: { min: CDM1.cdm, max: CDM1.cdm },
    shapes: [
      ...COMMON_SHAPES,
      ...EVENT_SHAPES,
      ...REST_SHAPES,
      ...extensions.flatMap((e) => e.shapes),
    ],
    messages: [...MESSAGES, ...extensions.flatMap((e) => e.messages)],
    operations: [...OPERATIONS, ...extensions.flatMap((e) => e.operations)],
    notifications: [...NOTIFICATIONS, ...extensions.flatMap((e) => e.notifications)],
    webhooks: [...WEBHOOKS, ...extensions.flatMap((e) => e.webhooks)],
    features: [...FEATURES, ...extensions.flatMap((e) => e.features)],
    errors: ERRORS,
    closeCodes: CLOSE_CODES,
    gaps: GAPS,
    decisions: DECISIONS,
  };
}

/** Protocol 1.0 with the additions of 12 §10. */
export const DEP1: DepDefinition = defineDep([FRW_EXTENSION]);

/** Visits every shape nested in `shape`, depth first. */
export function walkShape(shape: Shape, visit: (s: Shape) => void): void {
  visit(shape);
  switch (shape.kind) {
    case 'array':
      walkShape(shape.items, visit);
      break;
    case 'object':
      for (const p of Object.values(shape.props)) walkShape(p.shape, visit);
      break;
    case 'map':
      if (shape.keys) walkShape(shape.keys, visit);
      walkShape(shape.values, visit);
      break;
    case 'anyOf':
      for (const s of shape.of) walkShape(s, visit);
      break;
    case 'nullable':
      walkShape(shape.of, visit);
      break;
    default:
      break;
  }
}

/**
 * Consistency checks on a definition: unique names, every reference resolves, every gap and
 * decision referenced exists, envelope rules hold. Returns the problems found (empty when sound).
 */
export function checkDefinition(def: DepDefinition): string[] {
  const problems: string[] = [];
  const names = new Map<string, number>();
  for (const s of def.shapes) names.set(s.name, (names.get(s.name) ?? 0) + 1);
  for (const [n, c] of names) if (c > 1) problems.push(`shape ${n} is defined ${c} times`);

  const resolved = new Set(def.gaps.filter((g) => g.resolved).map((g) => g.id));
  const withdrawn = new Set(def.decisions.filter((d) => d.status === 'withdrawn').map((d) => d.id));
  const annotations = (a: Annotated, where: string) => {
    for (const g of a.gaps ?? []) {
      if (!GAP_IDS.has(g)) problems.push(`${where}: unknown gap ${g}`);
      if (resolved.has(g)) problems.push(`${where}: gap ${g} is resolved; follow the spec instead`);
    }
    for (const d of a.decisions ?? []) {
      if (!DECISION_IDS.has(d)) problems.push(`${where}: unknown decision ${d}`);
      if (withdrawn.has(d)) problems.push(`${where}: decision ${d} is withdrawn`);
    }
  };
  const shape = (s: Shape, where: string) =>
    walkShape(s, (x) => {
      annotations(x, where);
      if (x.kind === 'ref' && !names.has(x.name))
        problems.push(`${where}: unknown shape ${x.name}`);
      if (x.kind === 'object')
        for (const [k, p] of Object.entries(x.props)) {
          annotations(p, `${where}.${k}`);
          if (typeof p.required === 'object' && !(p.required.if.prop in x.props))
            problems.push(`${where}.${k}: requiredIf names unknown member ${p.required.if.prop}`);
        }
    });

  for (const s of def.shapes) shape(s.shape, `shape ${s.name}`);

  const types = new Set<string>();
  for (const m of def.messages) {
    const where = `message ${m.t}`;
    if (types.has(m.t)) problems.push(`${where}: defined twice`);
    types.add(m.t);
    if (!/^(x-)?[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/.test(m.t))
      problems.push(`${where}: bad type name`);
    annotations(m, where);
    if (m.payload) shape(m.payload, where);
    if (m.payload && m.payload.kind !== 'ref' && m.payload.kind !== 'object')
      problems.push(`${where}: payload must be an object or a reference`);
    if (m.payload && m.payload.kind === 'object' && !m.payloadName)
      problems.push(`${where}: inline payload needs a payloadName`);
    const correlated = (m.replies ?? []).some(
      (r) => def.messages.find((x) => x.t === r)?.re === 'required',
    );
    if (correlated && m.id !== 'required')
      problems.push(`${where}: a message answered by a reply with \`re\` must require id`);
    if (m.feature && !def.features.some((f) => f.name === m.feature))
      problems.push(`${where}: unknown feature ${m.feature}`);
  }
  for (const m of def.messages)
    for (const r of m.replies ?? []) {
      const reply = def.messages.find((x) => x.t === r);
      if (!reply) problems.push(`message ${m.t}: unknown reply ${r}`);
      else if (reply.re === 'none')
        problems.push(`message ${m.t}: reply ${r} is marked as never a reply`);
    }

  const ops = new Set<string>();
  const routes = new Set<string>();
  for (const o of def.operations) {
    const where = `operation ${o.operationId}`;
    if (ops.has(o.operationId)) problems.push(`${where}: duplicate operationId`);
    ops.add(o.operationId);
    const route = `${o.method} ${o.path}`;
    if (routes.has(route)) problems.push(`${where}: duplicate route ${route}`);
    routes.add(route);
    annotations(o, where);
    if (o.body) shape(o.body, `${where} body`);
    if (o.success.body) shape(o.success.body, `${where} response`);
    for (const [k, p] of Object.entries(o.query ?? {})) shape(p.shape, `${where} query ${k}`);
    for (const p of o.path.matchAll(/\{(\w+)\}/g)) {
      const name = p[1]!;
      if (!o.params?.[name] && !PATH_PARAMS[name])
        problems.push(`${where}: no shape for path parameter ${name}`);
    }
    if ((o.method === 'PUT' || o.method === 'PATCH') && o.ifMatch !== 'required')
      problems.push(`${where}: updates require If-Match (05 §6.1; D15)`);
    if (o.feature && !def.features.some((f) => f.name === o.feature))
      problems.push(`${where}: unknown feature ${o.feature}`);
  }

  const hooks = new Set<string>();
  for (const w of def.webhooks) {
    const t = webhookType(w);
    if (hooks.has(t)) problems.push(`webhook ${t}: defined twice`);
    hooks.add(t);
    annotations(w, `webhook ${t}`);
    if (!/^dep\.[a-z_]+(\.[a-z_]+)+$/.test(w.name)) problems.push(`webhook ${t}: bad name`);
  }
  for (const n of def.notifications) annotations(n, `notification ${n.type}`);
  for (const e of def.errors) annotations({ gaps: e.gaps ?? [] }, `error ${e.code}`);
  for (const d of def.decisions)
    for (const g of d.gaps)
      if (!GAP_IDS.has(g)) problems.push(`decision ${d.id}: unknown gap ${g}`);
  return problems;
}
