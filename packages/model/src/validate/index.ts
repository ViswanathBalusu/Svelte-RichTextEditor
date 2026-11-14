/**
 * `@docedit/model/validate`: the invariant engine (CDM-013) with its stable codes and registration
 * point, attribute grammars (I11), the reader (CDM-009) and the field checks of FRW.
 */
export { validate, validateDoc, LIMITS } from './validate.ts';
export type {
  CodeDoc,
  DocumentView,
  IdentifierChange,
  IndexedNode,
  InvariantCheck,
  InvariantId,
  ValidationContext,
  ValidationResult,
  Violation,
  ViolationReport,
} from './types.ts';
export { VIOLATION_CODES, type BuiltInCode } from './codes.ts';
export { BUILT_IN_CHECKS, MODEL_CODES } from './built-in.ts';
export { registerInvariant, registeredInvariants } from './registry.ts';
export { readDocument, writeDocument, supportedVersions } from './read.ts';
export type { ReadOptions, ReadResult, SupportedVersions } from './read.ts';
export {
  checkGrammar,
  codePointLength,
  grammarProblems,
  CLARK_NAME_PATTERN,
  type GrammarProblem,
} from './grammar-check.ts';
export { FIELD_CODES, FIELD_INVARIANTS } from '../fields/invariants.ts';
export { fieldValueProblem, isCalendarDate, valueBytes } from '../fields/values.ts';
export type { ValueOptions, ValueProblem } from '../fields/values.ts';
