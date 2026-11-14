/**
 * Field values typed by kind (12 §3.3; FRW-003; invariant I15). One function decides whether a
 * value fits its kind, so that `model.validate()`, the authority's fill check (P7) and the
 * editor's own checks (FRW-004) agree. Null means empty for every kind.
 */
import { canonicalize } from '../canonical/jcs.ts';
import { UUID7_PATTERN } from '../conventions/ids.ts';
import { utf8 } from '../conventions/platform.ts';
import { isDecimalString } from '../conventions/validators.ts';
import { FIELD_LIMITS, SIGNATURE_MODES } from '../definition/fields.ts';
import type { JsonValue } from '../definition/grammar.ts';

const uuidRe = new RegExp(UUID7_PATTERN);
const dateRe = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** An ISO 8601 calendar date, `YYYY-MM-DD`, that exists in the proleptic Gregorian calendar. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = dateRe.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= days;
}

/** UTF-8 bytes of a value: of the text for a string, of its canonical JSON for anything else. */
export function valueBytes(value: JsonValue): number {
  return typeof value === 'string' ? utf8(value).length : utf8(canonicalize(value)).length;
}

export interface ValueProblem {
  /** `size`: above 4 KiB; `type`: not the type of the kind. */
  kind: 'size' | 'type';
  message: string;
}

export interface ValueOptions {
  /** The `options` of a choice field. */
  options?: ReadonlyArray<{ id?: unknown }> | null;
}

/** Whether `value` fits a field of `kind`; null when it does (12 §3.3). */
export function fieldValueProblem(
  kind: string,
  value: JsonValue | undefined,
  opts: ValueOptions = {},
): ValueProblem | null {
  if (value === null || value === undefined) return null;
  let bytes: number;
  try {
    bytes = valueBytes(value);
  } catch {
    return { kind: 'type', message: 'the value is not JSON' };
  }
  if (bytes > FIELD_LIMITS.valueBytes)
    return { kind: 'size', message: `value of ${bytes} bytes, more than 4 KiB` };
  const type = (message: string): ValueProblem => ({ kind: 'type', message });
  // The same checks as @docedit/rules (checkFieldValue; ADR 0030 §6), so both give one verdict.
  switch (kind) {
    case 'text':
      return typeof value === 'string' ? null : type('value must be a string');
    case 'number':
      return isDecimalString(value)
        ? null
        : type('value must be a decimal string of at most 64 characters, never a number');
    case 'formula':
      return typeof value === 'string' ? null : type('value must be a decimal string or a string');
    case 'date':
    case 'dateSigned':
      return isCalendarDate(value) ? null : type('value must be an ISO 8601 calendar date');
    case 'checkbox':
      return typeof value === 'boolean' ? null : type('value must be a boolean');
    case 'choice': {
      const options = opts.options ?? [];
      return typeof value === 'string' && options.some((o) => o.id === value)
        ? null
        : type('value must be the id of one of its options');
    }
    case 'signature':
    case 'initials': {
      const ok =
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 2 &&
        typeof value['asset'] === 'string' &&
        uuidRe.test(value['asset']) &&
        (SIGNATURE_MODES as readonly string[]).includes(String(value['mode']));
      return ok ? null : type('value must be { asset, mode } with mode typed, drawn or uploaded');
    }
    default:
      return type(`the kind ${JSON.stringify(kind)} holds no value in version 1`);
  }
}
