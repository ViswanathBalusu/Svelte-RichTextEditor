/**
 * The shape language of the DEP definition (SPK-019, PRO-001 to PRO-003).
 *
 * Every message, resource body and webhook payload is described once, as data, with these shapes.
 * The generators turn them into TypeScript types, JSON Schema, AsyncAPI and OpenAPI; the codec
 * validates frames against the same data at run time.
 *
 * Two rules from 05 §1 shape the language:
 * - every object is open: receivers MUST ignore fields they do not know (rule 3), so no shape forbids
 *   additional members;
 * - a minor version only adds fields, message types, resources, event types and feature names
 *   (rule 2), so enumerations are closed (`enum`) except the open vocabularies, which are strings
 *   with documented values (`known`). See decision D1.
 */

/** References to the gap register (gaps.ts) and the decision register (decisions.ts). */
export interface Annotated {
  /** Description in plain British English. */
  doc?: string;
  /** Where the prose defines it, for example "05 §5.3". */
  spec?: string;
  /** Gaps in the prose that this element depends on. */
  gaps?: readonly string[];
  /** Decisions taken by S6 where the prose is silent or contradicts itself. */
  decisions?: readonly string[];
}

export type StringFormat =
  /** UUID version 7 in canonical text form (01 §8). */
  | 'uuid7'
  /** RFC 3339 UTC timestamp with milliseconds (01 §8). */
  | 'timestamp'
  /** 16-character node identifier (03 §9). */
  | 'nodeId'
  /** Scope identifier: `doc`, `body`, `defs`, `region:<id>`, `story:<id>`, `field:<id>` (05 §5.3). */
  | 'scope'
  /** Absolute URI. */
  | 'uri'
  /** URI reference, for example a resource path relative to `rest` (05 §2). */
  | 'uri-reference'
  /** Lower-case hexadecimal SHA-256. */
  | 'sha256'
  /** Protocol version `MAJOR.MINOR` (05 §1 rule 1). */
  | 'version'
  /** Feature or message-type name (05 §1 rules 4 and 5). */
  | 'name'
  /** BCP 47 language tag (01 §8). */
  | 'language';

export interface StringShape extends Annotated {
  kind: 'string';
  /** A closed set of values. */
  enum?: readonly string[];
  /** Documented values of an open vocabulary; any string is accepted. */
  known?: readonly string[];
  format?: StringFormat;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

export interface IntegerShape extends Annotated {
  kind: 'integer';
  min?: number;
  max?: number;
}

export interface BooleanShape extends Annotated {
  kind: 'boolean';
}

export interface ConstShape extends Annotated {
  kind: 'const';
  value: string | number | boolean;
}

export interface ArrayShape extends Annotated {
  kind: 'array';
  items: Shape;
  minItems?: number;
  maxItems?: number;
  unique?: boolean;
}

/** A requirement that holds only when another member has a given value (JSON Schema if/then). */
export interface RequiredIf {
  if: { prop: string; equals: string | number | boolean };
}

export interface Prop extends Annotated {
  shape: Shape;
  required: boolean | RequiredIf;
}

export interface ObjectShape extends Annotated {
  kind: 'object';
  props: Readonly<Record<string, Prop>>;
  /**
   * Members beyond those listed are part of the value's meaning (a step's `from`, `to`, `slice`),
   * not just tolerated: the TypeScript type gets an index signature.
   */
  openMembers?: true;
}

/** An object used as a dictionary: every member has the same shape. */
export interface MapShape extends Annotated {
  kind: 'map';
  keys?: StringShape;
  values: Shape;
  maxEntries?: number;
}

/** A reference to a named shape of the definition. */
export interface RefShape extends Annotated {
  kind: 'ref';
  name: string;
}

export interface AnyOfShape extends Annotated {
  kind: 'anyOf';
  of: readonly Shape[];
}

export interface NullableShape extends Annotated {
  kind: 'nullable';
  of: Shape;
}

/** Any JSON value. */
export interface AnyShape extends Annotated {
  kind: 'any';
}

/** A shape defined by the CDM schema (spec/cdm), referenced and never copied (PRO-003). */
export interface ExternalShape extends Annotated {
  kind: 'external';
  target: 'cdm-doc' | 'cdm-envelope';
}

export type Shape =
  | StringShape
  | IntegerShape
  | BooleanShape
  | ConstShape
  | ArrayShape
  | ObjectShape
  | MapShape
  | RefShape
  | AnyOfShape
  | NullableShape
  | AnyShape
  | ExternalShape;

/** A named shape: generated as a TypeScript type and as a reusable schema component. */
export interface NamedShape {
  name: string;
  shape: Shape;
  /** Which epic owns the shape; another epic registers its own (PRO-001 criterion 4). */
  owner: string;
}

// ---------------------------------------------------------------------------------------------
// Constructors. They never write `undefined` into an optional member (exactOptionalPropertyTypes).

type Opts<T> = Omit<T, 'kind'>;

function withKind<K extends Shape['kind'], T extends object>(kind: K, o: T): { kind: K } & T {
  return { kind, ...o };
}

/* @__NO_SIDE_EFFECTS__ */
export const str = (o: Opts<StringShape> = {}): StringShape => withKind('string', o);
/* @__NO_SIDE_EFFECTS__ */
export const int = (o: Opts<IntegerShape> = {}): IntegerShape => withKind('integer', o);
/* @__NO_SIDE_EFFECTS__ */
export const bool = (o: Opts<BooleanShape> = {}): BooleanShape => withKind('boolean', o);
/* @__NO_SIDE_EFFECTS__ */
export const lit = (value: string | number | boolean, o: Annotated = {}): ConstShape => ({
  kind: 'const',
  value,
  ...o,
});
/* @__NO_SIDE_EFFECTS__ */
export const arr = (items: Shape, o: Omit<Opts<ArrayShape>, 'items'> = {}): ArrayShape => ({
  kind: 'array',
  items,
  ...o,
});
/* @__NO_SIDE_EFFECTS__ */
export const obj = (
  props: Record<string, Prop>,
  o: Annotated & { openMembers?: true } = {},
): ObjectShape => ({
  kind: 'object',
  props,
  ...o,
});
/* @__NO_SIDE_EFFECTS__ */
export const map = (values: Shape, o: Omit<Opts<MapShape>, 'values'> = {}): MapShape => ({
  kind: 'map',
  values,
  ...o,
});
/* @__NO_SIDE_EFFECTS__ */
export const ref = (name: string, o: Annotated = {}): RefShape => ({ kind: 'ref', name, ...o });
/* @__NO_SIDE_EFFECTS__ */
export const anyOf = (of: readonly Shape[], o: Annotated = {}): AnyOfShape => ({
  kind: 'anyOf',
  of,
  ...o,
});
/* @__NO_SIDE_EFFECTS__ */
export const nullable = (of: Shape, o: Annotated = {}): NullableShape => ({
  kind: 'nullable',
  of,
  ...o,
});
/* @__NO_SIDE_EFFECTS__ */
export const any = (o: Annotated = {}): AnyShape => ({ kind: 'any', ...o });
/* @__NO_SIDE_EFFECTS__ */
export const external = (target: ExternalShape['target'], o: Annotated = {}): ExternalShape => ({
  kind: 'external',
  target,
  ...o,
});

/** A closed enumeration. */
/* @__NO_SIDE_EFFECTS__ */
export const enm = (values: readonly string[], o: Opts<StringShape> = {}): StringShape =>
  str({ ...o, enum: values });

/** A required member. */
/* @__NO_SIDE_EFFECTS__ */
export const req = (shape: Shape, doc?: string, o: Annotated = {}): Prop =>
  doc === undefined ? { shape, required: true, ...o } : { shape, required: true, doc, ...o };

/** An optional member. */
/* @__NO_SIDE_EFFECTS__ */
export const opt = (shape: Shape, doc?: string, o: Annotated = {}): Prop =>
  doc === undefined ? { shape, required: false, ...o } : { shape, required: false, doc, ...o };

/** A member required only when `prop` equals `equals`. */
/* @__NO_SIDE_EFFECTS__ */
export const reqIf = (
  shape: Shape,
  prop: string,
  equals: string | number | boolean,
  doc?: string,
  o: Annotated = {},
): Prop => {
  const required: RequiredIf = { if: { prop, equals } };
  return doc === undefined ? { shape, required, ...o } : { shape, required, doc, ...o };
};

// ---------------------------------------------------------------------------------------------
// Common scalar shapes.

export const SAFE_MAX = 9007199254740991;

/* @__NO_SIDE_EFFECTS__ */
export const uuid7 = (o: Opts<StringShape> = {}): StringShape => str({ format: 'uuid7', ...o });
/* @__NO_SIDE_EFFECTS__ */
export const timestamp = (o: Opts<StringShape> = {}): StringShape =>
  str({ format: 'timestamp', ...o });
/* @__NO_SIDE_EFFECTS__ */
export const nodeId = (o: Opts<StringShape> = {}): StringShape => str({ format: 'nodeId', ...o });
/* @__NO_SIDE_EFFECTS__ */
export const scope = (o: Opts<StringShape> = {}): StringShape => str({ format: 'scope', ...o });
/** A sequence number: 0 is the content before the first commit (04 §1). */
/* @__NO_SIDE_EFFECTS__ */
export const seq = (o: Opts<IntegerShape> = {}): IntegerShape =>
  int({ min: 0, max: SAFE_MAX, ...o });
/** A non-negative duration in milliseconds. */
/* @__NO_SIDE_EFFECTS__ */
export const ms = (o: Opts<IntegerShape> = {}): IntegerShape =>
  int({ min: 0, max: SAFE_MAX, ...o });
/** A non-negative count or size. */
/* @__NO_SIDE_EFFECTS__ */
export const count = (o: Opts<IntegerShape> = {}): IntegerShape =>
  int({ min: 0, max: SAFE_MAX, ...o });
/* @__NO_SIDE_EFFECTS__ */
export const text = (o: Opts<StringShape> = {}): StringShape => str(o);
