/**
 * The rules fixtures (FRW-020), by category. `@docedit/rules/fixtures` gives them to the authority
 * service's tests and to the conformance kit; spec/rules/ publishes the same cases as JSON.
 */
import type { FixtureCase, FixtureSet } from '../conformance.ts';
import { LIMITS } from '../limits.ts';
import { RULES_STATUS, RULES_VERSION } from '../version.ts';
import { dateCases } from './dates.ts';
import { decimalCases } from './decimal.ts';
import { invalidCases } from './invalid.ts';
import { operatorCases } from './operators.ts';
import { patternCases } from './patterns.ts';
import { ruleCases } from './rules.ts';
import { PRESETS, valueCases } from './values.ts';

export const FIXTURE_CASES: readonly FixtureCase[] = [
  ...operatorCases,
  ...decimalCases,
  ...dateCases,
  ...patternCases,
  ...ruleCases,
  ...invalidCases,
  ...valueCases,
];

export const FIXTURES: FixtureSet & {
  status: string;
  presets: typeof PRESETS;
  limits: typeof LIMITS;
} = {
  rules: RULES_VERSION,
  status: RULES_STATUS,
  presets: PRESETS,
  limits: LIMITS,
  cases: FIXTURE_CASES,
};
