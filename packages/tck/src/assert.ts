/**
 * Assertions of the kit. A failure names what the specification requires (`expected`) and what the
 * server did (`received`), so that a report is enough to file a defect against a target.
 */
import { canonicalize } from '@docedit/model';

const MAX_SHOWN = 600;

/** A value as the report shows it: JSON, shortened. */
export function show(v: unknown): string {
  let s: string;
  try {
    s = v === undefined ? 'undefined' : (JSON.stringify(v) ?? String(v));
  } catch {
    s = String(v);
  }
  return s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN)}… (${s.length} characters)` : s;
}

/** An expectation the target did not meet. */
export class KitFailure extends Error {
  readonly expected: string | undefined;
  readonly received: string | undefined;

  constructor(message: string, expected?: unknown, received?: unknown) {
    super(message);
    this.name = 'KitFailure';
    this.expected = expected === undefined ? undefined : show(expected);
    this.received = received === undefined ? undefined : show(received);
  }
}

/** A scenario that cannot run against this target or configuration, with the reason. */
export class KitSkip extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'KitSkip';
  }
}

export function isKitFailure(e: unknown): e is KitFailure {
  return e instanceof KitFailure;
}

export function isKitSkip(e: unknown): e is KitSkip {
  return e instanceof KitSkip;
}

export function fail(message: string, expected?: unknown, received?: unknown): never {
  throw new KitFailure(message, expected, received);
}

export function check(
  condition: unknown,
  message: string,
  expected?: unknown,
  received?: unknown,
): asserts condition {
  if (!condition) throw new KitFailure(message, expected, received);
}

export function equal<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) throw new KitFailure(message, expected, actual);
}

/** Deep equality of JSON values, by their RFC 8785 text. */
export function jsonEqual(actual: unknown, expected: unknown, message: string): void {
  const a = canonicalize(JSON.parse(JSON.stringify(actual ?? null)));
  const e = canonicalize(JSON.parse(JSON.stringify(expected ?? null)));
  if (a !== e) throw new KitFailure(message, expected, actual);
}

export function includes<T>(list: readonly T[] | undefined, item: T, message: string): void {
  if (!list || !list.includes(item))
    throw new KitFailure(message, `a list with ${show(item)}`, list);
}

export function excludes<T>(list: readonly T[] | undefined, item: T, message: string): void {
  if (list?.includes(item)) throw new KitFailure(message, `a list without ${show(item)}`, list);
}

export function oneOf<T>(actual: T, allowed: readonly T[], message: string): void {
  if (!allowed.includes(actual)) throw new KitFailure(message, `one of ${show(allowed)}`, actual);
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The member of a JSON object, or undefined. */
export function member(v: unknown, key: string): unknown {
  return isObject(v) ? v[key] : undefined;
}
