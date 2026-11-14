/**
 * Validates JSON values against definition shapes at run time (PRO-004 groundwork). It reads the
 * same data as the schema generators, so a frame the codec accepts is one the published JSON Schema
 * accepts; a test compares the two verdicts on generated examples.
 *
 * Unknown members are never a violation (05 §1 rule 3). Validation never throws and never executes
 * anything from the value.
 */
import {
  BCP47_PATTERN,
  NODE_ID_PATTERN,
  SHA256_HEX_PATTERN,
  UUID7_PATTERN,
  isTimestamp,
} from '@docedit/model';
import type { DepDefinition } from '../definition/extension.ts';
import { SAFE_MAX, type Prop, type Shape, type StringShape } from '../definition/shapes.ts';
import { NAME_PATTERN, SCOPE_PATTERN, VERSION_PATTERN } from '../generate/json-schema.ts';

export interface Violation {
  /** JSON Pointer (RFC 6901) to the offending value. */
  path: string;
  message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const URI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/;
const URI_REFERENCE = /^[^\s]*$/;

const escape = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

/** Deep equality of JSON values, for `uniqueItems`. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && jsonEqual(a[k], b[k]));
  }
  return false;
}

export class ShapeValidator {
  private readonly named: ReadonlyMap<string, Shape>;
  private readonly patterns = new Map<string, RegExp>();
  private readonly limit: number;

  constructor(def: DepDefinition, opts: { maxViolations?: number } = {}) {
    this.named = new Map(def.shapes.map((s) => [s.name, s.shape]));
    this.limit = opts.maxViolations ?? 16;
  }

  /** Violations of `value` against `shape`; empty when valid. */
  check(shape: Shape, value: unknown, path = ''): Violation[] {
    const out: Violation[] = [];
    this.visit(shape, value, path, out, 0);
    return out;
  }

  /** Violations against a named shape. */
  checkNamed(name: string, value: unknown): Violation[] {
    const shape = this.named.get(name);
    if (!shape) return [{ path: '', message: `unknown shape ${name}` }];
    return this.check(shape, value);
  }

  private re(pattern: string): RegExp {
    let r = this.patterns.get(pattern);
    if (!r) {
      r = new RegExp(pattern, 'u');
      this.patterns.set(pattern, r);
    }
    return r;
  }

  private add(out: Violation[], path: string, message: string): void {
    if (out.length < this.limit) out.push({ path, message });
  }

  private visit(shape: Shape, value: unknown, path: string, out: Violation[], depth: number): void {
    if (out.length >= this.limit) return;
    if (depth > 64) return this.add(out, path, 'nested too deeply');
    switch (shape.kind) {
      case 'string':
        return this.string(shape, value, path, out);
      case 'integer':
        if (typeof value !== 'number' || !Number.isInteger(value))
          return this.add(out, path, 'expected an integer');
        if (value < (shape.min ?? -SAFE_MAX) || value > (shape.max ?? SAFE_MAX))
          return this.add(
            out,
            path,
            `expected an integer from ${shape.min ?? -SAFE_MAX} to ${shape.max ?? SAFE_MAX}`,
          );
        return;
      case 'boolean':
        if (typeof value !== 'boolean') this.add(out, path, 'expected a boolean');
        return;
      case 'const':
        if (value !== shape.value) this.add(out, path, `expected ${JSON.stringify(shape.value)}`);
        return;
      case 'array': {
        if (!Array.isArray(value)) return this.add(out, path, 'expected an array');
        if (shape.minItems !== undefined && value.length < shape.minItems)
          this.add(out, path, `expected at least ${shape.minItems} items`);
        if (shape.maxItems !== undefined && value.length > shape.maxItems)
          this.add(out, path, `expected at most ${shape.maxItems} items`);
        if (shape.unique)
          for (let i = 0; i < value.length; i++)
            for (let j = i + 1; j < value.length; j++)
              if (jsonEqual(value[i], value[j]))
                return this.add(out, `${path}/${j}`, 'duplicate item');
        value.forEach((v, i) => this.visit(shape.items, v, `${path}/${i}`, out, depth + 1));
        return;
      }
      case 'object':
        return this.object(shape.props, value, path, out, depth);
      case 'map': {
        if (!isObject(value)) return this.add(out, path, 'expected an object');
        const keys = Object.keys(value);
        if (shape.maxEntries !== undefined && keys.length > shape.maxEntries)
          this.add(out, path, `expected at most ${shape.maxEntries} members`);
        for (const k of keys) {
          if (shape.keys) {
            const before = out.length;
            this.string(shape.keys, k, `${path}/${escape(k)}`, out);
            if (out.length > before) continue;
          }
          this.visit(shape.values, value[k], `${path}/${escape(k)}`, out, depth + 1);
        }
        return;
      }
      case 'ref': {
        const target = this.named.get(shape.name);
        if (!target) return this.add(out, path, `unknown shape ${shape.name}`);
        return this.visit(target, value, path, out, depth + 1);
      }
      case 'anyOf': {
        for (const option of shape.of) if (this.check(option, value, path).length === 0) return;
        return this.add(out, path, 'matches none of the alternatives');
      }
      case 'nullable':
        if (value === null) return;
        return this.visit(shape.of, value, path, out, depth + 1);
      case 'any':
        return;
      case 'external':
        // CDM content: the codec checks the envelope only; model.validate() checks the document.
        if (!isObject(value)) this.add(out, path, 'expected a CDM object');
        return;
    }
  }

  private string(shape: StringShape, value: unknown, path: string, out: Violation[]): void {
    if (typeof value !== 'string') return this.add(out, path, 'expected a string');
    if (shape.minLength !== undefined && [...value].length < shape.minLength)
      this.add(out, path, `expected at least ${shape.minLength} characters`);
    if (shape.maxLength !== undefined && [...value].length > shape.maxLength)
      this.add(out, path, `expected at most ${shape.maxLength} characters`);
    if (shape.enum && !shape.enum.includes(value))
      this.add(out, path, `expected one of ${shape.enum.join(', ')}`);
    if (shape.pattern && !this.re(shape.pattern).test(value))
      this.add(out, path, 'does not match the pattern');
    switch (shape.format) {
      case undefined:
        return;
      case 'uuid7':
        if (!this.re(UUID7_PATTERN).test(value)) this.add(out, path, 'expected a UUID version 7');
        return;
      case 'timestamp':
        if (!isTimestamp(value))
          this.add(out, path, 'expected an RFC 3339 UTC timestamp with milliseconds');
        return;
      case 'nodeId':
        if (!this.re(NODE_ID_PATTERN).test(value))
          this.add(out, path, 'expected a node identifier');
        return;
      case 'scope':
        if (!this.re(SCOPE_PATTERN).test(value)) this.add(out, path, 'expected a scope identifier');
        return;
      case 'uri':
        if (!URI.test(value)) this.add(out, path, 'expected an absolute URI');
        return;
      case 'uri-reference':
        if (!URI_REFERENCE.test(value)) this.add(out, path, 'expected a URI reference');
        return;
      case 'sha256':
        if (!this.re(SHA256_HEX_PATTERN).test(value))
          this.add(out, path, 'expected a lower-case hexadecimal SHA-256');
        return;
      case 'version':
        if (!this.re(VERSION_PATTERN).test(value)) this.add(out, path, 'expected MAJOR.MINOR');
        return;
      case 'name':
        if (!this.re(NAME_PATTERN).test(value)) this.add(out, path, 'expected a feature name');
        return;
      case 'language':
        if (!this.re(BCP47_PATTERN).test(value))
          this.add(out, path, 'expected a BCP 47 language tag');
        return;
    }
  }

  private object(
    props: Readonly<Record<string, Prop>>,
    value: unknown,
    path: string,
    out: Violation[],
    depth: number,
  ): void {
    if (!isObject(value)) return this.add(out, path, 'expected an object');
    for (const [name, p] of Object.entries(props)) {
      const present =
        Object.prototype.hasOwnProperty.call(value, name) && value[name] !== undefined;
      const required =
        p.required === true ||
        (typeof p.required === 'object' && value[p.required.if.prop] === p.required.if.equals);
      if (!present) {
        if (required) this.add(out, `${path}/${escape(name)}`, 'is required');
        continue;
      }
      this.visit(p.shape, value[name], `${path}/${escape(name)}`, out, depth + 1);
    }
  }
}
