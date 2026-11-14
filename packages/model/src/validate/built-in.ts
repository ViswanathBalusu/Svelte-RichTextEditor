/**
 * The checks that run on every `validate()` call through the registration interface, and the full
 * list of codes the model publishes (spec/cdm/cdm-1.violations.json).
 */
import { FIELD_CODES, FIELD_INVARIANTS } from '../fields/invariants.ts';
import { VIOLATION_CODES } from './codes.ts';
import type { CodeDoc, InvariantCheck } from './types.ts';

/** FRW's field invariants, through the same interface as any registered check (CDM-022). */
export const BUILT_IN_CHECKS: readonly InvariantCheck[] = [FIELD_INVARIANTS];

/** Every code the model itself can report, with its invariant and meaning. */
export const MODEL_CODES: Readonly<Record<string, CodeDoc>> = {
  ...VIOLATION_CODES,
  ...FIELD_CODES,
};
