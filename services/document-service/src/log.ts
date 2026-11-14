/**
 * Structured logs that carry identifiers and never content (06 §11; 10 §3.7; BE-088).
 *
 * A log line is one JSON object of known members only. Values are identifiers, codes, numbers and
 * fixed messages: there is no member for free text, a request body, a header or a query string, so
 * document text, comment bodies, field values, filenames, tokens, credentials, webhook secrets and
 * URL signatures have nowhere to go. URLs are logged as their path, with the query names kept and
 * their values dropped. Errors are logged by name and stack frames, without their message, which
 * may quote input (BE-088 criterion 3).
 */

export type LogLevel = 'info' | 'warn' | 'error';

/** The members a log line may have. */
export interface LogFields {
  event: string;
  tenant?: string;
  doc?: string;
  session?: string;
  requestId?: string;
  job?: string;
  method?: string;
  /** The route template, for example `/v1/documents/{id}`. */
  route?: string;
  /** A path with query values removed (redactUrl). */
  path?: string;
  status?: number;
  durationMs?: number;
  code?: string;
  /** The kind of credential: `user`, `service` or `none`; never the credential. */
  credential?: string;
  /**
   * A fixed message written by the service itself, or a validation summary of paths and rules
   * (`violationSummary`, BE-088 criterion 3). Never a value from the request.
   */
  message?: string;
  error?: string;
  stack?: string;
  traceId?: string;
}

const KEYS: ReadonlySet<string> = new Set([
  'event',
  'tenant',
  'doc',
  'session',
  'requestId',
  'job',
  'method',
  'route',
  'path',
  'status',
  'durationMs',
  'code',
  'credential',
  'message',
  'error',
  'stack',
  'traceId',
]);

export type LogSink = (line: string) => void;

export interface Logger {
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

const MAX = 300;

/** A logger that writes one JSON line per entry to `sink` (default standard output). */
export function createLogger(sink: LogSink = (l) => process.stdout.write(`${l}\n`)): Logger {
  const write = (level: LogLevel, fields: LogFields) => {
    const out: Record<string, string | number> = { time: new Date().toISOString(), level };
    for (const [k, v] of Object.entries(fields)) {
      if (!KEYS.has(k) || v === undefined) continue;
      if (typeof v === 'number') out[k] = v;
      else if (typeof v === 'string') out[k] = v.length > MAX ? `${v.slice(0, MAX)}…` : v;
    }
    sink(JSON.stringify(out));
  };
  return {
    info: (f) => write('info', f),
    warn: (f) => write('warn', f),
    error: (f) => write('error', f),
  };
}

/** A logger that writes nothing. */
export const SILENT: Logger = { info() {}, warn() {}, error() {} };

/**
 * A URL as it may be logged: the path, and the names of its query parameters without their values,
 * so that signatures, tokens and identifiers in queries never reach a log (BE-088 criterion 4).
 */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const names = url
    .slice(q + 1)
    .split('&')
    .map((p) => p.split('=')[0] ?? '')
    .filter(Boolean)
    .map((n) => `${encodeURIComponent(decodeSafe(n))}=[redacted]`);
  return `${url.slice(0, q)}?${names.join('&')}`;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The position and rule of each violation of a request, as a log message (BE-088 criterion 3):
 * `/title: a string; (body): valid JSON (RFC 8259)`. A path that is not a plain pointer (a key the
 * client chose, say) is written as `(key)`, so no value of the request reaches the log. At most
 * three violations are named; the rest are counted.
 */
export function violationSummary(
  violations: readonly { path: string; rule: string }[] | undefined,
): string | undefined {
  if (!violations || violations.length === 0) return undefined;
  const parts = violations.slice(0, 3).map((v) => {
    const path =
      v.path === '' ? '(body)' : /^[A-Za-z0-9_/.\-[\]]{1,120}$/.test(v.path) ? v.path : '(key)';
    return `${path}: ${v.rule.slice(0, 120)}`;
  });
  if (violations.length > 3) parts.push(`and ${violations.length - 3} more`);
  return parts.join('; ').slice(0, MAX);
}

/** An error as it may be logged: its name and the frames of its stack, never its message. */
export function errorFields(e: unknown): { error: string; stack?: string } {
  if (!(e instanceof Error)) return { error: typeof e };
  const frames = (e.stack ?? '')
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at '))
    .slice(0, 8)
    .join(' | ');
  return frames ? { error: e.name, stack: frames } : { error: e.name };
}
