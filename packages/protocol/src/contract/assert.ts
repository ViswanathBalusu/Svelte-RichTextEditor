/**
 * Assertions for the contract suite. Universal and runner-neutral: a failure throws a
 * ContractFailure, which any test runner reports.
 */
import { canonicalize } from '@docedit/model';

export class ContractFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractFailure';
  }
}

const show = (v: unknown): string => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ContractFailure(message);
}

export function equal<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected))
    throw new ContractFailure(`${message}: expected ${show(expected)}, got ${show(actual)}`);
}

/** Deep equality of JSON values, by RFC 8785 canonical text. */
export function jsonEqual(actual: unknown, expected: unknown, message: string): void {
  const a = canonicalize(JSON.parse(JSON.stringify(actual ?? null)));
  const e = canonicalize(JSON.parse(JSON.stringify(expected ?? null)));
  if (a !== e) throw new ContractFailure(`${message}:\n  expected ${e}\n  got      ${a}`);
}

export function includes<T>(list: readonly T[] | undefined, item: T, message: string): void {
  if (!list || !list.includes(item))
    throw new ContractFailure(`${message}: ${show(item)} not in ${show(list)}`);
}

export function excludes<T>(list: readonly T[] | undefined, item: T, message: string): void {
  if (list?.includes(item))
    throw new ContractFailure(`${message}: ${show(item)} unexpectedly in ${show(list)}`);
}

/** Awaits a promise that must reject; returns the error for further checks. */
export async function rejects(promise: Promise<unknown>, message: string): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new ContractFailure(`${message}: the promise resolved`);
}

/** The `code` of an error that should carry one (PortError, SyncRejectError). */
export function codeOf(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string'
    ? e.code
    : undefined;
}

export function oneOf<T>(actual: T, allowed: readonly T[], message: string): void {
  if (!allowed.includes(actual))
    throw new ContractFailure(`${message}: expected one of ${show(allowed)}, got ${show(actual)}`);
}
