/**
 * The text of a `date` field (03 §4.4, §7; CDM-035, CDM-005). The time zone is an argument with no
 * default: it is the zone of the workflow or of the export job, never the client's (03 §7). The
 * instant is a server time (01 §8), so nothing here reads a clock.
 *
 * `format` is a picture made of these tokens; everything else, and text in single quotes, is
 * literal (ADR 0032): `yyyy` year, `yy` two-digit year, `MM` and `M` month, `dd` and `d` day,
 * `HH` and `H` hour (0 to 23), `mm` minutes, `ss` seconds. Month and day names are not supported
 * in version 1, because they need locale data that differs between engines. A null format gives
 * `yyyy-MM-dd`.
 *
 * Time zone rules come from the ECMAScript internationalisation API (`Intl.DateTimeFormat`), which
 * every supported engine and Node.js provide; fixtures use zones whose rules are long settled.
 */
import { parseTimestamp } from '../conventions/time.ts';

export const DEFAULT_DATE_FORMAT = 'yyyy-MM-dd';

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
      era: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The calendar date and wall-clock time of an instant in a time zone. */
export function zonedParts(instantMs: number, timeZone: string): Parts {
  const out: Record<string, number> = {};
  let bc = false;
  for (const p of formatter(timeZone).formatToParts(instantMs)) {
    if (p.type === 'era') bc = p.value.startsWith('B');
    else if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  const year = out['year'] ?? 0;
  return {
    year: bc ? 1 - year : year,
    month: out['month'] ?? 1,
    day: out['day'] ?? 1,
    hour: (out['hour'] ?? 0) % 24,
    minute: out['minute'] ?? 0,
    second: out['second'] ?? 0,
  };
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

function token(run: string, p: Parts): string | null {
  switch (run) {
    case 'yyyy':
      return pad(p.year, 4);
    case 'yy':
      return pad(p.year % 100, 2);
    case 'MM':
      return pad(p.month, 2);
    case 'M':
      return String(p.month);
    case 'dd':
      return pad(p.day, 2);
    case 'd':
      return String(p.day);
    case 'HH':
      return pad(p.hour, 2);
    case 'H':
      return String(p.hour);
    case 'mm':
      return pad(p.minute, 2);
    case 'ss':
      return pad(p.second, 2);
    default:
      return null;
  }
}

/** Applies a date picture to the parts of a date (see the module comment). */
export function formatDateParts(parts: Parts, format: string): string {
  let out = '';
  for (let i = 0; i < format.length;) {
    const ch = format[i]!;
    if (ch === "'") {
      const end = format.indexOf("'", i + 1);
      const stop = end < 0 ? format.length : end;
      out += format.slice(i + 1, stop);
      i = stop + 1;
      continue;
    }
    let j = i + 1;
    while (j < format.length && format[j] === ch) j++;
    const run = format.slice(i, j);
    out += /[A-Za-z]/.test(ch) ? (token(run, parts) ?? run) : run;
    i = j;
  }
  return out;
}

export interface DateFieldInput {
  /** An RFC 3339 UTC timestamp with milliseconds (01 §8), assigned by the server. */
  readonly instant: string;
  /** An IANA time zone name: the workflow's or the export job's (03 §7). */
  readonly timeZone: string;
  /** The field's `format`; null or absent gives `yyyy-MM-dd`. */
  readonly format?: string | null | undefined;
}

/** The text of a `date` field. Throws a RangeError for a malformed instant or an unknown zone. */
export function dateFieldText(input: DateFieldInput): string {
  if (typeof input.timeZone !== 'string' || input.timeZone === '')
    throw new RangeError('dateFieldText: a time zone is required (03 §7)');
  const ms = parseTimestamp(input.instant);
  return formatDateParts(zonedParts(ms, input.timeZone), input.format ?? DEFAULT_DATE_FORMAT);
}
