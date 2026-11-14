/**
 * `validateFields()` (12 §10 embedding API; FRW-004, FRW-047): for every visible field, whether it
 * is required and empty, whether its entry passes the static checks, and the messages of the
 * `validate` effects that apply. The editor calls it while a participant fills; the completion
 * check calls it with the stored values. Hidden fields are skipped: their values are cleared at
 * completion (12 §5.3).
 */
import type { JsonValue } from '@docedit/model';
import type { Evaluation, FieldState, ValueMap } from './evaluate.ts';
import { type EntryProblem, type FieldInfo, checkEntry, isEmptyValue } from './fields.ts';

export interface FieldReport {
  key: string;
  id?: string | null;
  problems: EntryProblem[];
}

export function validateFields(
  fields: readonly FieldInfo[],
  values: ValueMap,
  evaluation?: Evaluation,
  context: { attachedAssets?: ReadonlySet<string> } = {},
): FieldReport[] {
  const states = new Map<string, FieldState>();
  if (evaluation?.ok) for (const s of evaluation.fields) states.set(s.key, s);
  const out: FieldReport[] = [];
  for (const f of fields) {
    const st = states.get(f.key);
    if (st && !st.visible) continue;
    const value: JsonValue | undefined =
      f.kind === 'formula' && st ? (st.value ?? null) : values[f.key];
    const required = st ? st.required : f.required === true;
    const problems: EntryProblem[] = [];
    if (required && isEmptyValue(f, value))
      problems.push({ code: 'required', message: 'this field is required' });
    problems.push(...checkEntry(f, value, context));
    for (const m of st?.messages ?? [])
      problems.push({ code: 'rule', rule: m.rule, message: m.message });
    if (problems.length) {
      const report: FieldReport = { key: f.key, problems };
      if (f.id !== undefined) report.id = f.id;
      out.push(report);
    }
  }
  return out;
}
