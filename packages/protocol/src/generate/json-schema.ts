/**
 * Turns definition shapes into JSON Schema (SPK-019; PRO-001 to PRO-003).
 *
 * The output uses only keywords that mean the same in draft-07 (the AsyncAPI 3.0 schema format) and
 * in draft 2020-12 (OpenAPI 3.1 and the standalone schemas): no keyword sits beside `$ref`; nullable
 * values are `anyOf` with `{ "type": "null" }`; conditional requirements are `if`/`then`.
 *
 * No object forbids additional members: receivers MUST ignore fields they do not know (05 §1 rule 3).
 */
import {
  BCP47_PATTERN,
  NODE_ID_PATTERN,
  SHA256_HEX_PATTERN,
  TIMESTAMP_PATTERN,
  UUID7_PATTERN,
} from '@docedit/model';
import type { Annotated, NamedShape, Prop, Shape, StringShape } from '../definition/shapes.ts';
import { SAFE_MAX } from '../definition/shapes.ts';

export type JsonSchema = Record<string, unknown>;

/** Scope identifiers of 05 §5.3; `<id>` is a node identifier (03 §9). */
export const SCOPE_PATTERN = '^(doc|body|defs|(region|story|field):[A-Za-z0-9_-]{16})$';
/** Feature names (05 §1 rules 4 and 5; gap G01). */
export const NAME_PATTERN = '^[a-z][a-z0-9-]*$';
/** Message type names; experimental ones start with `x-` (05 §1 rule 5; gap G01). */
export const MESSAGE_TYPE_PATTERN = '^(x-)?[a-z][a-zA-Z0-9]*(\\.[a-z][a-zA-Z0-9]*)*$';
/** Protocol versions `MAJOR.MINOR` (05 §1 rule 1). */
export const VERSION_PATTERN = '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$';

export interface SchemaOptions {
  /** Prefix of references to named shapes, for example `#/components/schemas/`. */
  refBase: string;
  /** Reference to the CDM schema for an external shape. */
  cdmRef: (target: 'cdm-doc' | 'cdm-envelope') => string;
}

const FORMAT: Record<NonNullable<StringShape['format']>, { pattern?: string; format?: string }> = {
  uuid7: { pattern: UUID7_PATTERN, format: 'uuid' },
  timestamp: { pattern: TIMESTAMP_PATTERN, format: 'date-time' },
  nodeId: { pattern: NODE_ID_PATTERN },
  scope: { pattern: SCOPE_PATTERN },
  uri: { format: 'uri' },
  'uri-reference': { format: 'uri-reference' },
  sha256: { pattern: SHA256_HEX_PATTERN },
  version: { pattern: VERSION_PATTERN },
  name: { pattern: NAME_PATTERN },
  language: { pattern: BCP47_PATTERN },
};

/** The `$comment` that carries spec references, gaps and decisions. */
export function comment(a: Annotated): string | undefined {
  const parts: string[] = [];
  if (a.spec) parts.push(a.spec);
  if (a.gaps?.length) parts.push(`gaps: ${[...new Set(a.gaps)].join(', ')}`);
  if (a.decisions?.length) parts.push(`decisions: ${[...new Set(a.decisions)].join(', ')}`);
  return parts.length ? parts.join('; ') : undefined;
}

/** Adds description and `$comment`, wrapping a bare `$ref` so that no keyword sits beside it. */
function annotate(schema: JsonSchema, a: Annotated): JsonSchema {
  const description = a.doc;
  const note = comment(a);
  if (!description && !note) return schema;
  const base = '$ref' in schema ? { allOf: [schema] } : { ...schema };
  const out: JsonSchema = {};
  if (description) out['description'] = description;
  if (note) out['$comment'] = note;
  return { ...out, ...base };
}

function merge(a: Annotated, b: Annotated): Annotated {
  const out: Annotated = {};
  const doc = b.doc ?? a.doc;
  if (doc !== undefined) out.doc = doc;
  const spec = b.spec ?? a.spec;
  if (spec !== undefined) out.spec = spec;
  const gaps = [...(a.gaps ?? []), ...(b.gaps ?? [])];
  if (gaps.length) out.gaps = gaps;
  const decisions = [...(a.decisions ?? []), ...(b.decisions ?? [])];
  if (decisions.length) out.decisions = decisions;
  return out;
}

function stringSchema(s: StringShape): JsonSchema {
  const out: JsonSchema = { type: 'string' };
  const f = s.format ? FORMAT[s.format] : undefined;
  if (f?.format) out['format'] = f.format;
  const patterns = [f?.pattern, s.pattern].filter((p): p is string => p !== undefined);
  if (patterns.length === 1) out['pattern'] = patterns[0];
  if (s.minLength !== undefined) out['minLength'] = s.minLength;
  if (s.maxLength !== undefined) out['maxLength'] = s.maxLength;
  if (s.enum) out['enum'] = [...s.enum];
  if (s.known) out['examples'] = [...s.known];
  if (patterns.length > 1) return { ...out, allOf: patterns.map((p) => ({ pattern: p })) };
  return out;
}

/** The schema of one shape, without its own annotations (the caller adds them). */
function bare(shape: Shape, o: SchemaOptions): JsonSchema {
  switch (shape.kind) {
    case 'string':
      return stringSchema(shape);
    case 'integer':
      return { type: 'integer', minimum: shape.min ?? -SAFE_MAX, maximum: shape.max ?? SAFE_MAX };
    case 'boolean':
      return { type: 'boolean' };
    case 'const':
      return { const: shape.value };
    case 'array': {
      const out: JsonSchema = { type: 'array', items: toSchema(shape.items, o) };
      if (shape.minItems !== undefined) out['minItems'] = shape.minItems;
      if (shape.maxItems !== undefined) out['maxItems'] = shape.maxItems;
      if (shape.unique) out['uniqueItems'] = true;
      return out;
    }
    case 'object':
      return objectSchema(shape.props, o);
    case 'map': {
      const out: JsonSchema = { type: 'object', additionalProperties: toSchema(shape.values, o) };
      if (shape.keys) out['propertyNames'] = stringSchema(shape.keys);
      if (shape.maxEntries !== undefined) out['maxProperties'] = shape.maxEntries;
      return out;
    }
    case 'ref':
      return { $ref: `${o.refBase}${shape.name}` };
    case 'anyOf':
      if (shape.of.every((s) => s.kind === 'const'))
        return { enum: shape.of.map((s) => (s.kind === 'const' ? s.value : null)) };
      return { anyOf: shape.of.map((s) => toSchema(s, o)) };
    case 'nullable':
      return { anyOf: [toSchema(shape.of, o), { type: 'null' }] };
    case 'any':
      return {};
    case 'external':
      return { $ref: o.cdmRef(shape.target) };
  }
}

function objectSchema(props: Readonly<Record<string, Prop>>, o: SchemaOptions): JsonSchema {
  const properties: JsonSchema = {};
  const required: string[] = [];
  const conditional: JsonSchema[] = [];
  for (const [name, p] of Object.entries(props)) {
    properties[name] = propSchema(p, o);
    if (p.required === true) required.push(name);
    else if (typeof p.required === 'object') {
      const c = p.required.if;
      conditional.push({
        if: { properties: { [c.prop]: { const: c.equals } }, required: [c.prop] },
        then: { properties: { [name]: {} }, required: [name] },
      });
    }
  }
  const out: JsonSchema = { type: 'object', properties };
  if (required.length) out['required'] = required;
  if (conditional.length) out['allOf'] = conditional;
  return out;
}

export function propSchema(p: Prop, o: SchemaOptions): JsonSchema {
  return annotate(bare(p.shape, o), merge(p.shape, p));
}

/** The schema of a shape with its annotations. */
export function toSchema(shape: Shape, o: SchemaOptions): JsonSchema {
  return annotate(bare(shape, o), shape);
}

/** A named shape as a reusable component, titled with its name. */
export function namedSchema(n: NamedShape, o: SchemaOptions): JsonSchema {
  const s = toSchema(n.shape, o);
  return '$ref' in s ? { title: n.name, allOf: [s] } : { title: n.name, ...s };
}
