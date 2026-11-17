/**
 * `@docedit/rules`: the field rules language (12 §5; ADR 0012; ADR 0030), one implementation for
 * the editor, the authority and the authority service (12 §5.2).
 *
 * - `compileRules` checks rules against a document's fields and roles and returns a rule set, or
 *   every problem with its path (FRW-015, FRW-018, FRW-019).
 * - `evaluateRules` evaluates a rule set in dependency order: visibility, enablement, requirement,
 *   `validate` messages and formula values (FRW-016, FRW-017, FRW-019). `evaluateDocument` is the
 *   authority service's `evaluateRules` on a whole document (05 §10).
 * - `checkFieldValue`, `checkEntry` and `validateFields` are the static checks of a value: its type
 *   for its kind, `required`, and the limits of `validation` (FRW-003, FRW-004).
 * - `checkRuleInvariants` gives the rule halves of I14 and I15 (12 §3.6).
 * - Decimals, calendar dates and patterns are exported for the editor's controls.
 */
export { LIMITS } from './limits.ts';
export { RULES_STATUS, RULES_VERSION } from './version.ts';
export { DEFINITION_ID_PATTERN, FIELD_KEY_PATTERN } from './cdm.ts';

export {
  COMPARISON_OPERATORS,
  FIELD_EFFECTS,
  FORMULA_OPERATORS,
  LOGIC_OPERATORS,
  OPERANDS,
  OPERATORS,
  PREDICATE_OPERATORS,
  ROUTING_EFFECTS,
  compileExpression,
  compileRules,
  rulesFromList,
  type CompileEnvironment,
  type CompileResult,
  type CompiledRule,
  type Effect,
  type Expr,
  type FieldEffect,
  type Operator,
  type ProblemCode,
  type RuleInput,
  type RuleProblem,
  type RuleSet,
  type RuntimeError,
  type Type,
  type Value,
} from './language.ts';

export {
  encodeValue,
  evaluateExpression,
  evaluateRules,
  type EncodedValue,
  type Evaluation,
  type EvaluationContext,
  type FieldState,
  type RuleOutcome,
  type ValueMap,
} from './evaluate.ts';

export {
  FIELD_KINDS,
  PRESETS,
  PRESET_NAMES,
  checkEntry,
  checkFieldDefinition,
  checkFieldValue,
  isEmptyValue,
  kindType,
  type DefinitionProblem,
  type EntryProblem,
  type EntryProblemCode,
  type FieldInfo,
  type FieldKind,
  type FieldValidation,
  type PresetName,
  type ValueType,
} from './fields.ts';

export { validateFields, type FieldReport } from './validate.ts';

export {
  MAX_RULES,
  checkRuleInvariants,
  compileDocument,
  evaluateDocument,
  fieldFrom,
  readDocument,
  type DocumentRules,
  type RuleViolation,
} from './document.ts';

export {
  compileRouting,
  evaluateRouting,
  type CompiledRoute,
  type RouteOutcome,
  type RouteResult,
  type RoutingAction,
  type RoutingCompileResult,
  type RoutingEffect,
  type RoutingEnvironment,
  type RoutingEvaluation,
  type RoutingSet,
} from './routing.ts';

export {
  type Decimal,
  type DecimalError,
  add,
  calculate,
  compare as compareDecimals,
  divide,
  formatDecimal,
  multiply,
  negate,
  parseDecimal,
  round,
  subtract,
} from './decimal.ts';

export { calendarDateIn, formatDate, isCalendarDate, isTimeZone, parseDate } from './dates.ts';

export {
  compilePattern,
  matchPattern,
  maxMatchSteps,
  type MatchResult,
  type Pattern,
  type PatternProblem,
} from './pattern.ts';

export { checkDocumentPatterns, type PatternSaveProblem } from './definitions.ts';

export { derivedFromHidden, type HiddenDerivation } from './hidden.ts';

export {
  PROFILE,
  runCase,
  runFixtures,
  type ConformanceReport,
  type FixtureCase,
  type FixtureSet,
} from './conformance.ts';
export { generateRulesSchema } from './schema.ts';
