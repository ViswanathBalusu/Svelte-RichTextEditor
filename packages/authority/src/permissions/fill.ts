/**
 * Rule P7 (12 §4.2; FRW-008): where a user has `fill` but not `edit`, the only change a commit may
 * make is to the `value` of form fields for which all of these hold: the field's `assignee` is one
 * of the participant's roles; the participant is active; the field is visible and enabled under the
 * rules. P7 is a module of the outcome check, registered as `FILL_RULE` (PRM-010): without it no
 * field value can change except under P1.
 *
 * What the module does not decide, because the core of the check or the invariants already do and
 * no module may relax them: values of server-set kinds (P8), concurrent fills (P9), values a reader
 * cannot read (ADR 0019), and the type of the new value (I15, `field_invalid` at 04 §5 step 6).
 */
import type { FillContext, FillRule, RuleVerdict } from './registry.ts';
import type { FieldChange } from './scopes.ts';

const no = (reason: string): RuleVerdict => ({ ok: false, reason });

export function checkFill(field: FieldChange, ctx: FillContext): RuleVerdict {
  const { access } = ctx;
  if (!access.fill.allowed) return no('needs `fill`');
  const assignee = field.node.attrs['assignee'];
  if (typeof assignee !== 'string' || !access.fill.roles.includes(assignee))
    return no('the field is not assigned to one of your roles');
  if (!access.fill.active) return no('your participant is not active in the workflow');
  // A static `readOnly` flag disables the field as a rule would (12 §3.2; ADR 0033).
  if (field.node.attrs['readOnly'] === true) return no('the field is read-only');
  if (ctx.fieldEnabled && !ctx.fieldEnabled(field.id, ctx.after, String(field.node.attrs['key'])))
    return no('the field is hidden or disabled by the rules');
  return { ok: true };
}

/** P7 as a registered module of the outcome check. */
export const FILL_RULE: FillRule = Object.freeze({ id: 'P7', check: checkFill });
