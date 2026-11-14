/**
 * The authority-side conditions of the sign endpoint (12 §8.1 step 3; FRW-046), as pure functions.
 *
 * - `checkSign` decides whether one `signature` or `initials` field may be written by the server on
 *   a participant's behalf. It is the P7 conditions (`checkFill`: the assignee is one of the
 *   participant's roles, the participant is active, the field is visible and enabled, not read-only)
 *   with the kind inverted: P7 excludes the server-set kinds from fills, the sign endpoint allows
 *   only them. Visibility is required here, not assumed: without `fieldEnabled` the sign is refused.
 * - `fieldsToDateSign` lists the `dateSigned` fields assigned to the same role, which one signing
 *   commit sets in the same commit (12 §8.1 step 3).
 * - `signedDate` gives the date a `dateSigned` field receives: the date in the workflow's time zone
 *   of the server's instant, never the client's clock or the server's own zone.
 *
 * The endpoint, the commit and the refusal response are not here; they are the workflow service's.
 */
import type { Node } from 'prosemirror-model';
import { checkFill } from './fill.ts';
import type { FillContext, RuleVerdict } from './registry.ts';
import type { FieldChange } from './scopes.ts';

const no = (reason: string): RuleVerdict => ({ ok: false, reason });

const SIGN_KINDS: ReadonlySet<unknown> = new Set(['signature', 'initials']);

export function checkSign(field: FieldChange, ctx: FillContext): RuleVerdict {
  if (!SIGN_KINDS.has(field.node.attrs['kind']))
    return no('only a signature or initials field is signed');
  if (!ctx.fieldEnabled)
    return no('the field is not known to be visible and enabled, so it is not signed');
  return checkFill(field, ctx);
}

/** The ids of the `dateSigned` fields whose assignee is `role`, in document order. */
export function fieldsToDateSign(doc: Node, role: string): string[] {
  const ids: string[] = [];
  doc.descendants((n) => {
    if (
      n.type.name === 'form_field' &&
      n.attrs['kind'] === 'dateSigned' &&
      n.attrs['assignee'] === role &&
      typeof n.attrs['id'] === 'string'
    )
      ids.push(n.attrs['id']);
    return true;
  });
  return ids;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      throw new RangeError(`signedDate: "${timeZone}" is not a time zone`);
    }
    formatters.set(timeZone, f);
  }
  return f;
}

/**
 * The calendar date (`YYYY-MM-DD`) of an instant in a time zone (IANA name). Throws a RangeError for
 * an instant that is not finite or a time zone the platform does not know.
 */
export function signedDate(instantMs: number, timeZone: string): string {
  if (!Number.isFinite(instantMs)) throw new RangeError('signedDate: the instant is not finite');
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day))
    throw new RangeError('signedDate: the platform gave no calendar date');
  return `${year}-${month}-${day}`;
}
