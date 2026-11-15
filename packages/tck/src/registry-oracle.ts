/**
 * The registry oracle (PRO-038 criteria 2 and 3; 05 §5.8): every problem a server sends is checked
 * against the error registry, whatever the scenario was looking for. A code outside the registry,
 * a code on a surface the registry does not name for it, and a `rate_limited` or `quota_exceeded`
 * without its retry hint are defects of the server, and the scenario that saw them fails.
 *
 * The checks are those of the protocol package (`checkProblem`); the kit adds no rule of its own.
 */
import { checkProblem, type ProblemInput, type ServerMessage } from '@docedit/protocol';
import { isObject, show } from './assert.ts';
import type { HttpResponse } from './rest.ts';

/** The problem a message carries, or null when it carries none. */
function problemOfMessage(m: ServerMessage): ProblemInput | null {
  switch (m.t) {
    case 'error':
      return { surface: 'socket', code: m.d.code, retryAfterMs: m.d.retryAfterMs };
    case 'sync.reject':
      return { surface: 'sync', code: m.d.code, retryAfterMs: m.d.retryAfterMs, rule: m.d.rule };
    case 'ch.rejected':
      return { surface: 'channel-reject', code: m.d.code };
    case 'ch.closed':
      return { surface: 'channel-close', code: m.d.code };
    default:
      return null;
  }
}

/** What is wrong with the problem of an `error`, `sync.reject`, `ch.rejected` or `ch.closed`. */
export function messageProblems(m: ServerMessage): string[] {
  const input = problemOfMessage(m);
  if (!input) return [];
  return checkProblem(input).map((v) => `${m.t}: ${v.path} ${v.message} in ${show(m)}`);
}

/**
 * What is wrong with the problem document of a REST response. Only responses under `rest` are
 * read (a pre-signed storage address is not DEP), and only those that are problems: an error
 * status with the problem media type, or with a JSON body that has a `code`.
 */
export function responseProblems(res: HttpResponse, rest: string): string[] {
  if (res.status < 400) return [];
  const base = rest.replace(/\/+$/, '');
  if (res.url !== base && !res.url.startsWith(`${base}/`) && !res.url.startsWith(`${base}?`))
    return [];
  const media = res.headers.get('content-type') ?? '';
  const code = isObject(res.json) ? res.json['code'] : undefined;
  if (!media.startsWith('application/problem+json') && code === undefined) return [];
  const where = `${res.method} ${new URL(res.url).pathname} answered ${res.status}`;
  return checkProblem({
    surface: 'rest',
    code,
    retryAfterHeader: res.headers.get('retry-after') ?? undefined,
  }).map((v) => `${where}: ${v.path} ${v.message} in ${show(res.json ?? res.text)}`);
}
