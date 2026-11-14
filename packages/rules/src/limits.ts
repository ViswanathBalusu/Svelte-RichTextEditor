/**
 * Bounds of the rules language (ADR 0030 §9). The first group comes from the spec (12 §3.3, §3.6)
 * and from the CDM grammar of `rule_def` and `form_field` (packages/model, cdm1.ts). The second
 * group is proposed by ADR 0030; every value is a target to validate, not a measurement.
 */
export const LIMITS = {
  /** I15: rules in one document (12 §3.6). */
  rules: 500,
  /** I15: fields in one document (12 §3.6). */
  fields: 2000,
  /** I15: a value is at most 4 KiB of UTF-8 (12 §3.3, §3.6). */
  valueBytes: 4096,
  /** Canonical JSON bytes of `when`, `then` and `else` each (CDM grammar of `rule_def`). */
  ruleAttributeBytes: 16384,
  /** JSON nesting depth of `when`, `then` and `else` each, the top level counting as 1 (CDM grammar). */
  ruleDepth: 32,
  /** Code points of a pattern (CDM grammar of `validation.pattern`; the same for `matches`). */
  patternLength: 256,
  /** Code points of a `validate` message (the CDM's grammar for names and labels). */
  messageLength: 255,
  /** Characters of a decimal string (the CDM's decimal strings, `isDecimalString`). */
  decimalLength: 64,

  // Proposed by ADR 0030.
  /** Largest count in a counted repetition such as `{2,5}`. */
  patternRepeat: 100,
  /** Instructions of a compiled pattern after counted repetitions are expanded. */
  patternProgram: 1000,
  /** Fraction digits kept by `*` and `/` (truncated toward zero beyond them). */
  decimalScale: 20,
  /** A decimal result must be smaller than 10 to this power in magnitude, or it is `overflow`. */
  decimalMagnitude: 40,
  /** Largest number of places `round` accepts. */
  roundPlaces: 20,
} as const;
