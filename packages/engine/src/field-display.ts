/**
 * How a form field shows its value when nobody is editing it (12 §3.2, §11; FRW-079 criterion 4).
 *
 * The field's `format` changes the display only. The stored value, the entry a person types and the
 * checks of `@docedit/rules` all use the value as it is stored: a decimal stays a string such as
 * `"12.5"`, a date stays `YYYY-MM-DD`. This module only turns a stored value into the text a
 * control shows while it is not being edited.
 *
 * - `number`: `decimals` rounds half up in decimal, never through a binary float (12 §3.3), then
 *   `prefix` and `suffix` are added.
 * - `date`: `datePattern` is a picture of the tokens of ADR 0032 (`yyyy-MM-dd` by default), applied
 *   to the calendar date. A calendar date has no time zone, so it is read as noon UTC.
 *
 * The module reads no clock and no store. It is universal: no Node.js or browser API.
 */
import { dateFieldText } from '@docedit/model';

/** The `format` attribute of a form field (03 §11). */
export interface FieldFormat {
  readonly decimals?: number | null;
  readonly prefix?: string | null;
  readonly suffix?: string | null;
  readonly datePattern?: string | null;
}

const DECIMAL = /^-?[0-9]+(?:\.[0-9]+)?$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `value` rounded to `decimals` places, half up on the magnitude, as a decimal string. */
function roundDecimal(value: string, decimals: number): string {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  // One more digit than wanted decides the rounding.
  let digits = (whole + fraction.padEnd(decimals + 1, '0')).slice(0, whole.length + decimals + 1);
  const up = Number(digits[digits.length - 1]) >= 5;
  digits = digits.slice(0, -1);
  if (up) {
    const d = digits.split('').map(Number);
    let k = d.length - 1;
    while (k >= 0) {
      if (d[k]! < 9) {
        d[k]! += 1;
        break;
      }
      d[k] = 0;
      k--;
    }
    digits = (k < 0 ? '1' : '') + d.join('');
  }
  const w = digits.slice(0, digits.length - decimals) || '0';
  const f = digits.slice(digits.length - decimals);
  return `${negative ? '-' : ''}${w}${decimals > 0 ? `.${f}` : ''}`;
}

/**
 * The text a field of `kind` shows for the stored `value` under `format`, or null when the format
 * changes nothing and the control shows the value as it is.
 */
export function formatFieldValue(
  kind: string,
  value: unknown,
  format: FieldFormat | null | undefined,
): string | null {
  if (!format || typeof value !== 'string') return null;
  if (kind === 'number') {
    if (!DECIMAL.test(value)) return null;
    const { decimals, prefix, suffix } = format;
    if (typeof decimals !== 'number' && !prefix && !suffix) return null;
    const body = typeof decimals === 'number' ? roundDecimal(value, decimals) : value;
    return `${prefix ?? ''}${body}${suffix ?? ''}`;
  }
  if (kind === 'date') {
    if (!format.datePattern || !CALENDAR_DATE.test(value)) return null;
    try {
      return dateFieldText({
        instant: `${value}T12:00:00.000Z`,
        timeZone: 'UTC',
        format: format.datePattern,
      });
    } catch {
      // A date that does not exist (`2026-02-30`) or a bad pattern: the control shows the value.
      return null;
    }
  }
  return null;
}
