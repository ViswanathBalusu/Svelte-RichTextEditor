/**
 * Time (01 §8; FND-003): RFC 3339 timestamps in UTC with millisecond precision.
 *
 * Only times assigned by the server are trusted (04 G6). A client may format and display
 * timestamps, but nothing it supplies is recorded as the time of a commit, a fill or a signature.
 */

export type Timestamp = string & { readonly __brand: 'Timestamp' };

export const TIMESTAMP_PATTERN =
  '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$';
const timestampRe = new RegExp(TIMESTAMP_PATTERN);

/** Formats Unix milliseconds as `YYYY-MM-DDTHH:mm:ss.sssZ`. */
export function formatTimestamp(ms: number): Timestamp {
  if (!Number.isFinite(ms)) throw new RangeError(`formatTimestamp: not a finite time: ${ms}`);
  const text = new Date(Math.trunc(ms)).toISOString();
  if (!timestampRe.test(text)) {
    throw new RangeError(`formatTimestamp: year outside 0000 to 9999: ${text}`);
  }
  return text as Timestamp;
}

/** True when `value` is a timestamp in exactly the canonical form, and denotes a real instant. */
export function isTimestamp(value: unknown): value is Timestamp {
  if (typeof value !== 'string' || !timestampRe.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/** Parses a canonical timestamp to Unix milliseconds; throws on any other form. */
export function parseTimestamp(value: string): number {
  if (!isTimestamp(value))
    throw new RangeError(
      `parseTimestamp: not an RFC 3339 UTC timestamp with milliseconds: ${value}`,
    );
  return Date.parse(value);
}
