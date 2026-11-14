/**
 * The authority-side checks of a participant's completion (12 §5.3, §8.1 step 4; FRW-047), as pure
 * functions over a document. The endpoint, the `rules` commit and the workflow state are the
 * workflow service's; this module decides what the service must check and what it must clear.
 *
 * - `completionCheck` runs the rules on the stored values and then the static and rule checks of
 *   `@docedit/rules` (`validateFields`) for the fields assigned to the participant's roles that are
 *   visible and enabled. Any problem refuses the completion and names each field key and the rule
 *   or validation. A rule set the evaluation cannot run fails closed.
 * - `hiddenValuesToClear` lists the keys of hidden fields that still hold a value; the `rules`
 *   commit sets them to null (12 §5.3).
 */
import { type FieldReport, evaluateDocument, readDocument, validateFields } from '@docedit/rules';
import type { Node } from 'prosemirror-model';

/** The rule budget of one evaluation (the same figure as the room's commit budget). */
export const COMPLETION_RULE_BUDGET = 100_000;

export interface CompletionProblem {
  /** The field key, as the document names it. */
  key: string;
  /** The field identifier, or null when the document gives none. */
  id: string | null;
  /** `required`, `rule`, a static entry code (for example `pattern`), or `rules_unavailable`. */
  code: string;
  message: string;
  /** For a `validate` effect: the rule whose message this is. */
  rule?: string;
}

export type CompletionVerdict = { ok: true } | { ok: false; problems: CompletionProblem[] };

function assigneeOf(doc: Node): Map<string, { id: string | null; assignee: unknown }> {
  const out = new Map<string, { id: string | null; assignee: unknown }>();
  doc.descendants((n) => {
    if (n.type.name === 'form_field' && typeof n.attrs['key'] === 'string') {
      const id = typeof n.attrs['id'] === 'string' ? n.attrs['id'] : null;
      if (!out.has(n.attrs['key'])) out.set(n.attrs['key'], { id, assignee: n.attrs['assignee'] });
    }
    return true;
  });
  return out;
}

/**
 * Whether the participant may complete: every field assigned to one of `roles` that is visible and
 * enabled passes its required and validation checks on the stored values.
 */
export function completionCheck(
  doc: Node,
  roles: readonly string[],
  now: Parameters<typeof evaluateDocument>[1]['now'] = null,
  budget: number = COMPLETION_RULE_BUDGET,
): CompletionVerdict {
  const json = doc.toJSON();
  const evaluation = evaluateDocument(json, { roles: [...roles], now, budget });
  // A rule set that cannot be evaluated, or a budget that is spent, refuses completion (fail closed).
  if (!evaluation.ok)
    return {
      ok: false,
      problems: [
        {
          key: '',
          id: null,
          code: 'rules_unavailable',
          message: 'the rules could not be evaluated, so completion is refused',
        },
      ],
    };
  const read = readDocument(json);
  const owners = assigneeOf(doc);
  const mine = new Set(
    [...owners]
      .filter(([, v]) => typeof v.assignee === 'string' && roles.includes(v.assignee))
      .map(([key]) => key),
  );
  const reports: FieldReport[] = validateFields(
    read.fields.filter((f) => mine.has(f.key)),
    read.values,
    evaluation,
  );
  const problems: CompletionProblem[] = [];
  for (const r of reports)
    for (const p of r.problems) {
      const problem: CompletionProblem = {
        key: r.key,
        id: r.id ?? null,
        code: p.code,
        message: p.message,
      };
      if (p.rule !== undefined) problem.rule = p.rule;
      problems.push(problem);
    }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** The keys of the hidden fields (under `evaluation`) that hold a value, in document order. */
export function hiddenValuesToClear(
  doc: Node,
  evaluation: { fields: ReadonlyArray<{ key: string; visible: boolean }> },
): string[] {
  const hidden = new Set(evaluation.fields.filter((f) => !f.visible).map((f) => f.key));
  const keys: string[] = [];
  doc.descendants((n) => {
    if (
      n.type.name === 'form_field' &&
      typeof n.attrs['key'] === 'string' &&
      hidden.has(n.attrs['key']) &&
      n.attrs['value'] !== null &&
      n.attrs['value'] !== undefined &&
      !keys.includes(n.attrs['key'])
    )
      keys.push(n.attrs['key']);
    return true;
  });
  return keys;
}
