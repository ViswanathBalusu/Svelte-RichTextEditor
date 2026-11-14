/**
 * The registration point for invariants that other packages own (CDM-013; CDM-022): FRW's field
 * invariants run through it as a built-in check, and the rules package registers the rules' half
 * of I14 and I15 the same way. A registered check runs on every `validate()` call after the
 * built-in checks; a check passed in the context runs for that call only.
 */
import { BUILT_IN_CHECKS, MODEL_CODES } from './built-in.ts';
import type { InvariantCheck } from './types.ts';

const registered = new Map<string, InvariantCheck>();

/** Codes that a check may not declare: the model's own and those of every registered check. */
function takenCodes(except?: string): Map<string, string> {
  const taken = new Map<string, string>(Object.keys(MODEL_CODES).map((c) => [c, 'the model']));
  for (const [name, check] of registered)
    if (name !== except) for (const code of Object.keys(check.codes)) taken.set(code, name);
  return taken;
}

const CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/** Throws when a check's name or codes clash with what is already there. */
export function assertCheck(check: InvariantCheck, others: Map<string, string>): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(check.name))
    throw new RangeError(`invariant check name "${check.name}" is not a lower-case name`);
  for (const code of Object.keys(check.codes)) {
    if (!CODE_PATTERN.test(code))
      throw new RangeError(`check ${check.name}: code "${code}" is not a snake_case code`);
    const owner = others.get(code);
    if (owner)
      throw new RangeError(`check ${check.name}: code "${code}" is already used by ${owner}`);
  }
}

/**
 * Registers a check for every later `validate()` call; returns the function that removes it.
 * Throws on a second check with the same name or on a code that is already taken.
 */
export function registerInvariant(check: InvariantCheck): () => void {
  if (registered.has(check.name) || BUILT_IN_CHECKS.some((c) => c.name === check.name))
    throw new RangeError(`an invariant check named "${check.name}" is already registered`);
  assertCheck(check, takenCodes());
  registered.set(check.name, check);
  return () => {
    if (registered.get(check.name) === check) registered.delete(check.name);
  };
}

/** The registered checks, in registration order. */
export function registeredInvariants(): readonly InvariantCheck[] {
  return [...registered.values()];
}
