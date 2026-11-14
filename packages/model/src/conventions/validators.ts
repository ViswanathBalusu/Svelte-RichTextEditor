/**
 * Value validators shared by the component, the service and other implementers (01 §8; FND-003).
 * The patterns are ASCII-only regular expressions that behave the same in ECMAScript and in the
 * regular-expression dialects of common JSON Schema validators, because the JSON Schema of the CDM
 * reuses them (CDM-007: a validator in another language must return the same verdicts).
 */

/** Decimal strings: no exponent, no leading plus, no leading zeros, optional fraction (03 §1 principle 7). */
export const DECIMAL_PATTERN = '^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$';
/** Colours are `#RRGGBB` in upper case, so that hashes agree (CDM-002). */
export const COLOUR_PATTERN = '^#[0-9A-F]{6}$';
/**
 * Well-formed BCP 47 language tags (RFC 5646 `langtag` and private-use tags). Grandfathered tags
 * are not accepted.
 */
export const BCP47_PATTERN =
  '^(?:(?:[A-Za-z]{2,3}(?:-[A-Za-z]{3}){0,3}|[A-Za-z]{4,8})(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?(?:-(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*(?:-[0-9A-WY-Za-wy-z](?:-[A-Za-z0-9]{2,8})+)*(?:-[Xx](?:-[A-Za-z0-9]{1,8})+)?|[Xx](?:-[A-Za-z0-9]{1,8})+)$';

/** The largest integer RFC 8785 serialises identically in every language (I-JSON, RFC 7493). */
export const MAX_INTEROPERABLE_INTEGER = 2 ** 53 - 1;

const decimalRe = new RegExp(DECIMAL_PATTERN);
const colourRe = new RegExp(COLOUR_PATTERN);
const bcp47Re = new RegExp(BCP47_PATTERN);

export function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && decimalRe.test(value);
}

export function isColour(value: unknown): value is string {
  return typeof value === 'string' && colourRe.test(value);
}

/** Upper-cases a `#rrggbb` colour from an import; returns null for anything else. */
export function normaliseColour(value: string): string | null {
  const upper = value.toUpperCase();
  return colourRe.test(upper) ? upper : null;
}

export function isLanguageTag(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && bcp47Re.test(value);
}

export interface FloatFinding {
  /** JSON Pointer (RFC 6901) to the offending value. */
  path: string;
  value: number;
}

/**
 * Finds every number in a JSON value that is not an integer in the interoperable range. The CDM
 * contains no floating-point numbers (03 §1 principle 7); decimal values are strings.
 */
export function findNonIntegers(value: unknown, path = ''): FloatFinding[] {
  const out: FloatFinding[] = [];
  walk(value, path, out);
  return out;
}

function walk(value: unknown, path: string, out: FloatFinding[]): void {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || Math.abs(value) > MAX_INTEROPERABLE_INTEGER)
      out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}/${i}`, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(v, `${path}/${escapePointer(k)}`, out);
  }
}

export function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}
