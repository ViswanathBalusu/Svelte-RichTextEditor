/**
 * Calendar dates (12 §3.3, §5.1; ADR 0030 §4). A date is an RFC 3339 `full-date` (YYYY-MM-DD) in
 * the proleptic Gregorian calendar, years 0000 to 9999. Rules compare dates as day numbers, never as
 * strings.
 *
 * `{ "now": "date" }` is the calendar date of an instant in an IANA time zone. The instant is the
 * server's clock; the time zone is the workflow's. The mapping goes from an instant to the zone's
 * wall clock, and every instant has exactly one wall-clock reading, so daylight-saving gaps and
 * repeated hours never make the date ambiguous. The zone's rules come from the runtime's copy of the
 * IANA time-zone database, through ECMA-402 `Intl.DateTimeFormat`; when two runtimes hold different
 * releases of the database, the authority's answer wins (12 §5.3).
 */
import { isTimestamp, parseTimestamp } from '@docedit/model';

const dateRe = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

export const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function daysInMonth(y: number, m: number): number {
  return m === 2 ? (isLeapYear(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's days_from_civil). */
export function dayNumber(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The inverse of dayNumber. */
export function civilDate(day: number): [number, number, number] {
  const z = day + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

/** The day number of a calendar date string, or null when it is not a real date. */
export function parseDate(text: string): number | null {
  const m = dateRe.exec(text);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return dayNumber(y, mo, d);
}

export const isCalendarDate = (v: unknown): v is string =>
  typeof v === 'string' && parseDate(v) !== null;

export function formatDate(day: number): string {
  const [y, m, d] = civilDate(day);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Instants `now` accepts: the server's clock is never before 1970 (ADR 0030 §4). */
const FIRST_INSTANT = Date.UTC(1970, 0, 1);
const LAST_INSTANT = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

const TIME_ZONE_RE = /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/;
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(timeZone: string): Intl.DateTimeFormat | null {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = null;
    if (TIME_ZONE_RE.test(timeZone)) {
      try {
        // Gregorian calendar and Latin digits whatever the runtime's default locale is.
        f = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
          timeZone,
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
        });
      } catch {
        f = null;
      }
    }
    formatters.set(timeZone, f);
  }
  return f;
}

/** True for an IANA time-zone name that the runtime knows, such as `Europe/Berlin` or `UTC`. */
export const isTimeZone = (v: unknown): v is string =>
  typeof v === 'string' && formatter(v) !== null;

/**
 * The calendar date of an instant in a time zone, or null when the instant is not an RFC 3339 UTC
 * timestamp with milliseconds from 1970 to 9999 or the time zone is unknown. The host's own time
 * zone never enters: the zone is always given.
 */
export function calendarDateIn(instant: string, timeZone: string): string | null {
  if (!isTimestamp(instant)) return null;
  const ms = parseTimestamp(instant);
  if (ms < FIRST_INSTANT || ms > LAST_INSTANT) return null;
  const f = formatter(timeZone);
  if (!f) return null;
  let y = NaN;
  let m = NaN;
  let d = NaN;
  for (const part of f.formatToParts(ms)) {
    if (part.type === 'year') y = Number(part.value);
    else if (part.type === 'month') m = Number(part.value);
    else if (part.type === 'day') d = Number(part.value);
  }
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 0 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return formatDate(dayNumber(y, m, d));
}
