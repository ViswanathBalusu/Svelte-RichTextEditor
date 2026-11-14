/**
 * The form model of the field properties panel (FRW-073; 12 §3.2). The panel's inputs are text, so
 * this module turns a field's draft into the strings the inputs show, and the strings back into a
 * draft. Plain functions, without the DOM. JSON for `format` and `validation` is parsed here; a
 * value that is not a JSON object is reported as `badJson` for its property and is not committed.
 *
 * - `options`: one option per line, written `identifier | label`; a line without `|` is its own label.
 * - `width`: a decimal string; empty means no width (null). Anything else is kept as NaN, which the
 *   gate refuses as `badWidth`.
 * - `assignee`: the empty string means no role (null).
 */
import type { FieldDraft, FieldOption, FieldProperty } from './field-properties.ts';

/** The panel's inputs, as strings and booleans. */
export interface FieldForm {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly assignee: string;
  readonly required: boolean;
  readonly readOnly: boolean;
  readonly default: string;
  readonly placeholder: string;
  readonly options: string;
  readonly format: string;
  readonly validation: string;
  readonly width: string;
}

/** The form that shows a draft. */
export function formFromDraft(draft: FieldDraft): FieldForm {
  return {
    key: draft.key,
    kind: draft.kind,
    label: draft.label,
    assignee: draft.assignee ?? '',
    required: draft.required,
    readOnly: draft.readOnly,
    default: draft.default ?? '',
    placeholder: draft.placeholder ?? '',
    options: draft.options.map((o) => `${o.id} | ${o.label}`).join('\n'),
    format: draft.format === null ? '' : JSON.stringify(draft.format),
    validation: draft.validation === null ? '' : JSON.stringify(draft.validation),
    width: draft.width === null ? '' : String(draft.width),
  };
}

function optionsOf(text: string): FieldOption[] {
  const out: FieldOption[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const bar = line.indexOf('|');
    if (bar < 0) {
      const id = line.trim();
      out.push({ id, label: id });
    } else {
      out.push({ id: line.slice(0, bar).trim(), label: line.slice(bar + 1).trim() });
    }
  }
  return out;
}

/** A JSON object, or `bad` when the text is not one. Empty text is null. */
function objectOf(text: string): Readonly<Record<string, unknown>> | null | 'bad' {
  if (text.trim() === '') return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : 'bad';
  } catch {
    return 'bad';
  }
}

export interface FormReading {
  readonly draft: FieldDraft;
  /** The properties whose text is not valid JSON. */
  readonly jsonErrors: readonly FieldProperty[];
}

/** The draft the form describes, and the JSON properties it could not read. */
export function draftFromForm(form: FieldForm): FormReading {
  const jsonErrors: FieldProperty[] = [];
  const format = objectOf(form.format);
  if (format === 'bad') jsonErrors.push('format');
  const validation = objectOf(form.validation);
  if (validation === 'bad') jsonErrors.push('validation');
  const width = form.width.trim() === '' ? null : Number(form.width);
  const draft: FieldDraft = {
    key: form.key,
    kind: form.kind,
    label: form.label,
    assignee: form.assignee === '' ? null : form.assignee,
    required: form.required,
    readOnly: form.readOnly,
    default: form.default === '' ? null : form.default,
    placeholder: form.placeholder === '' ? null : form.placeholder,
    options: optionsOf(form.options),
    format: format === 'bad' ? null : format,
    validation: validation === 'bad' ? null : validation,
    width: width === null ? null : Number.isFinite(width) ? width : Number.NaN,
  };
  return { draft, jsonErrors };
}
