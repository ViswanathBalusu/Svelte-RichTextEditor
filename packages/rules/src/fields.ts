/**
 * Field kinds, the type of each kind's value, and the static checks of an entry (12 §3.2, §3.3;
 * FRW-003, FRW-004; ADR 0030 §6 and §8): the value's type for its kind, `required`, and the limits
 * `min`, `max`, `minLength`, `maxLength`, `pattern` and `preset`. The editor, the authority and the
 * completion check use these functions, so the checks have one implementation.
 */
import { fieldValueProblem, type JsonValue } from '@docedit/model';
import { compare, parseDecimal } from './decimal.ts';
import { codePointLength, isObject } from './json.ts';
import { LIMITS } from './limits.ts';
import { compilePattern, matchPattern, type Pattern, type PatternProblem } from './pattern.ts';

export const FIELD_KINDS = [
  'text',
  'number',
  'date',
  'checkbox',
  'choice',
  'signature',
  'initials',
  'dateSigned',
  'formula',
  'attachment',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export const PRESET_NAMES = ['email', 'phone', 'postcode'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

/**
 * The preset definitions (ADR 0030 §8, proposed for FRW-004), written in the pattern subset and
 * matched against the whole value.
 * - `email`: the "valid e-mail address" of the WHATWG HTML standard (the `input type=email` rule).
 * - `phone`: an optional `+` and an optional `(`, then 4 to 20 digits, with at most two of the
 *   separators space, `(`, `)`, `.`, `/` and `-` after each digit but the last.
 * - `postcode`: 2 to 10 letters, digits, spaces and hyphens, starting and ending with a letter or
 *   digit. Postcodes differ by country; this only refuses what no country uses.
 */
export const PRESETS: Readonly<Record<PresetName, string>> = {
  email:
    "[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*",
  phone: '\\+?\\(?(?:[0-9][ ()./-]{0,2}){3,19}[0-9]',
  postcode: '[A-Za-z0-9][A-Za-z0-9 -]{0,8}[A-Za-z0-9]',
};

export interface FieldValidation {
  min?: string;
  max?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  preset?: PresetName;
}

/** What the rules need to know of a `form_field` (12 §3.2). */
export interface FieldInfo {
  key: string;
  kind: FieldKind;
  /** The node identifier, when the field was read from a document. */
  id?: string | null;
  required?: boolean;
  readOnly?: boolean;
  /** For `choice`: the option identifiers. */
  options?: readonly string[] | null;
  validation?: FieldValidation | null;
}

/** The static type of a kind's value in rules; `formula` takes the type of its `set` (ADR 0030 §2). */
export type ValueType = 'boolean' | 'decimal' | 'string' | 'date' | 'signature';

export function kindType(kind: FieldKind): ValueType | null {
  switch (kind) {
    case 'text':
    case 'choice':
      return 'string';
    case 'number':
      return 'decimal';
    case 'date':
    case 'dateSigned':
      return 'date';
    case 'checkbox':
      return 'boolean';
    case 'signature':
    case 'initials':
      return 'signature';
    case 'formula':
    case 'attachment':
      return null;
  }
}

/** Codes of entry problems (FRW-004). */
export type EntryProblemCode =
  | 'type'
  | 'too_large'
  | 'not_an_option'
  | 'not_attached'
  | 'reserved_kind'
  | 'required'
  | 'min'
  | 'max'
  | 'min_length'
  | 'max_length'
  | 'pattern'
  | 'preset'
  | 'rule';

export interface EntryProblem {
  code: EntryProblemCode;
  message: string;
  /** For `rule`: the rule whose `validate` effect applies. */
  rule?: string;
}

/** What to tell the person who typed a value of the wrong type, by kind (FRW-004). */
const TYPE_MESSAGE: Record<FieldKind, string> = {
  text: 'enter text',
  formula: 'a formula value is a string',
  number: 'enter a number such as 12.50',
  date: 'enter a date as YYYY-MM-DD',
  dateSigned: 'enter a date as YYYY-MM-DD',
  checkbox: 'a checkbox is true or false',
  choice: 'choose one of the options',
  signature: 'a signature is { asset, mode } with mode typed, drawn or uploaded',
  initials: 'a signature is { asset, mode } with mode typed, drawn or uploaded',
  attachment: 'the attachment kind holds no value in version 1',
};

/**
 * Invariant I15's type check (12 §3.3): does a value have the type of its kind? Null means empty
 * for every kind. Returns the problem, or null when the value is acceptable.
 *
 * The verdict is `fieldValueProblem` of `@docedit/model`, the one function that `model.validate()`
 * and the authority's fill check also call (FRW-015 criterion 5). This function adds the codes
 * and the messages for a person, and the check of a signature image against the attached assets.
 */
export function checkFieldValue(
  field: Pick<FieldInfo, 'kind' | 'options'>,
  value: JsonValue | undefined,
  context: { attachedAssets?: ReadonlySet<string> } = {},
): EntryProblem | null {
  if (value === null || value === undefined) return null;
  if (field.kind === 'attachment')
    return { code: 'reserved_kind', message: TYPE_MESSAGE.attachment };
  const options = (field.options ?? []).map((id) => ({ id }));
  const problem = fieldValueProblem(field.kind, value, { options });
  if (problem !== null) {
    if (problem.kind === 'size')
      return { code: 'too_large', message: `the value is longer than ${LIMITS.valueBytes} bytes` };
    if (field.kind === 'choice' && typeof value === 'string')
      return { code: 'not_an_option', message: TYPE_MESSAGE.choice };
    return { code: 'type', message: TYPE_MESSAGE[field.kind] };
  }
  if (
    (field.kind === 'signature' || field.kind === 'initials') &&
    context.attachedAssets &&
    isObject(value) &&
    !context.attachedAssets.has(String(value['asset']))
  )
    return {
      code: 'not_attached',
      message: 'the signature image is not attached to this document',
    };
  return null;
}

/** Empty: null, the empty string for `text` and `formula`, false for `checkbox` (ADR 0030 §1). */
export function isEmptyValue(
  field: Pick<FieldInfo, 'kind'>,
  value: JsonValue | undefined,
): boolean {
  if (value === null || value === undefined) return true;
  if (field.kind === 'checkbox') return value === false;
  if (field.kind === 'text' || field.kind === 'formula') return value === '';
  return false;
}

export type DefinitionProblemCode =
  'not_applicable' | 'bad_limit' | 'duplicate_option' | PatternProblem['code'];

export interface DefinitionProblem {
  code: DefinitionProblemCode;
  /** JSON Pointer relative to the field's attributes. */
  path: string;
  message: string;
  construct?: string;
}

const compiledPreset = new Map<PresetName, Pattern>();
export function presetPattern(name: PresetName): Pattern {
  let p = compiledPreset.get(name);
  if (!p) {
    const r = compilePattern(PRESETS[name]);
    if (!r.ok)
      throw new Error(`preset ${name} is outside the pattern subset: ${r.problem.message}`);
    p = r.pattern;
    compiledPreset.set(name, p);
  }
  return p;
}

/**
 * Checks a field's own definition: limits that do not apply to its kind, limits in the wrong
 * order, duplicate option identifiers, and a `pattern` outside the subset (FRW-018: refused when
 * the author saves it, with the construct named).
 */
export function checkFieldDefinition(field: FieldInfo): DefinitionProblem[] {
  const out: DefinitionProblem[] = [];
  const v = field.validation ?? {};
  const forKinds = (name: keyof FieldValidation, kinds: FieldKind[]) => {
    if (v[name] !== undefined && !kinds.includes(field.kind))
      out.push({
        code: 'not_applicable',
        path: `/validation/${name}`,
        message: `${name} does not apply to a ${field.kind} field`,
      });
  };
  forKinds('min', ['number']);
  forKinds('max', ['number']);
  for (const name of ['minLength', 'maxLength', 'pattern', 'preset'] as const)
    forKinds(name, ['text']);
  if (v.min !== undefined && v.max !== undefined) {
    const lo = parseDecimal(v.min);
    const hi = parseDecimal(v.max);
    if (lo && hi && compare(lo, hi) > 0)
      out.push({ code: 'bad_limit', path: '/validation/min', message: 'min is larger than max' });
  }
  for (const name of ['min', 'max'] as const)
    if (v[name] !== undefined && !parseDecimal(v[name]))
      out.push({
        code: 'bad_limit',
        path: `/validation/${name}`,
        message: `${name} is a decimal string`,
      });
  if (v.minLength !== undefined && v.maxLength !== undefined && v.minLength > v.maxLength)
    out.push({
      code: 'bad_limit',
      path: '/validation/minLength',
      message: 'minLength is larger than maxLength',
    });
  if (v.pattern !== undefined) {
    const r = compilePattern(v.pattern);
    if (!r.ok)
      out.push({
        code: r.problem.code,
        path: '/validation/pattern',
        message: r.problem.message,
        construct: r.problem.construct,
      });
  }
  if (field.kind === 'choice') {
    const seen = new Set<string>();
    (field.options ?? []).forEach((id, i) => {
      if (seen.has(id))
        out.push({
          code: 'duplicate_option',
          path: `/options/${i}/id`,
          message: `the option identifier "${id}" is used twice`,
        });
      seen.add(id);
    });
  }
  return out;
}

/**
 * The static checks of one entry, apart from `required` (which also depends on the rules): the
 * value's type, then the limits of `validation`. An empty entry passes every limit; only
 * `required` refuses it. Lengths count Unicode code points (ADR 0018, ADR 0030 §8).
 */
export function checkEntry(
  field: FieldInfo,
  value: JsonValue | undefined,
  context: { attachedAssets?: ReadonlySet<string> } = {},
): EntryProblem[] {
  const typeProblem = checkFieldValue(field, value, context);
  if (typeProblem) return [typeProblem];
  if (isEmptyValue(field, value)) return [];
  const v = field.validation ?? {};
  const out: EntryProblem[] = [];
  if (field.kind === 'number' && typeof value === 'string') {
    const x = parseDecimal(value)!;
    const lo = v.min !== undefined ? parseDecimal(v.min) : null;
    const hi = v.max !== undefined ? parseDecimal(v.max) : null;
    if (lo && compare(x, lo) < 0) out.push({ code: 'min', message: `enter ${v.min} or more` });
    if (hi && compare(x, hi) > 0) out.push({ code: 'max', message: `enter ${v.max} or less` });
  }
  if (field.kind === 'text' && typeof value === 'string') {
    const n = codePointLength(value);
    if (v.minLength !== undefined && n < v.minLength)
      out.push({ code: 'min_length', message: `enter at least ${v.minLength} characters` });
    if (v.maxLength !== undefined && n > v.maxLength)
      out.push({ code: 'max_length', message: `enter at most ${v.maxLength} characters` });
    if (v.pattern !== undefined) {
      const r = compilePattern(v.pattern);
      // A pattern outside the subset is a definition problem (checkFieldDefinition); it never
      // makes an entry invalid on its own.
      if (r.ok && !matchPattern(r.pattern, value).matched)
        out.push({ code: 'pattern', message: 'the entry does not have the expected form' });
    }
    if (v.preset !== undefined && PRESET_NAMES.includes(v.preset)) {
      if (!matchPattern(presetPattern(v.preset), value).matched)
        out.push({
          code: 'preset',
          message: `enter a valid ${v.preset === 'postcode' ? 'postcode' : v.preset === 'phone' ? 'telephone number' : 'e-mail address'}`,
        });
    }
  }
  return out;
}
