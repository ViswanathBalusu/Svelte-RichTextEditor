/**
 * The shapes `FieldRules` (field-rules.ts) and its evaluation (field-rules-eval.ts) share, in a
 * module of their own so that the two do not import each other (FND-008).
 */

/** What the rules say about one field, for the control. */
export interface FieldRuleState {
  /** False while a rule hides the field: it is not drawn, not reachable, not counted. */
  readonly visible: boolean;
  /** False while a rule disables the field. */
  readonly enabled: boolean;
  /** Static `required` or a `require` effect; never for a hidden field. */
  readonly required: boolean;
  /** The messages of the `validate` effects whose condition fails, in rule order. */
  readonly messages: readonly string[];
  /** The computed value of a formula field (a decimal string or a string), or null. */
  readonly value: string | null;
  /** Whether the field is a formula, so that its value is shown and cannot be changed. */
  readonly computed: boolean;
}

/** What the last evaluation covered, for the tests and for a measurement. */
export interface RuleEvaluationStats {
  /** Evaluations made since the object was made. */
  readonly evaluations: number;
  /** How many of them compiled the rules again and evaluated every field. */
  readonly full: number;
  /** The number of fields the last evaluation covered; 0 when it was not needed. */
  readonly lastFields: number;
}
