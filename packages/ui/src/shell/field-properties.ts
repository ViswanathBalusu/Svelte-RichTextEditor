/**
 * The properties of a form field as the author edits them in the properties panel (FRW-073; 12 §3.2,
 * §4.3, §11). Plain functions, without the DOM: the panel (not yet built, see FRW-073 Notes) shows
 * the problems and commits only a draft without any; the commit is a patch of the changed attributes
 * only, so that it reads as ordinary attribute changes in the log (FRW-073 criterion 3).
 *
 * `sensitive` is not an editable property: it is reserved (12 §3.2) and is absent from
 * `FIELD_PROPERTIES` and from `FieldDraft`.
 */

/** The kinds of 12 §3.2. `attachment` is reserved and not offered. */
export const FIELD_KINDS = [
  'text',
  'number',
  'date',
  'checkbox',
  'choice',
  'signature',
  'initials',
  'dateSigned',
  'formula',
] as const;

/** The properties the panel shows and edits, in the order of 12 §3.2 (`sensitive` excluded). */
export const FIELD_PROPERTIES = [
  'key',
  'kind',
  'label',
  'assignee',
  'required',
  'readOnly',
  'default',
  'placeholder',
  'options',
  'format',
  'validation',
  'width',
] as const;

export type FieldProperty = (typeof FIELD_PROPERTIES)[number];

export interface FieldOption {
  readonly id: string;
  readonly label: string;
}

/** The attributes of a field the panel edits. `assignee` is a `role_def` identifier, or null. */
export interface FieldDraft {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly assignee: string | null;
  readonly required: boolean;
  readonly readOnly: boolean;
  readonly default: string | null;
  readonly placeholder: string | null;
  readonly options: readonly FieldOption[];
  readonly format: Readonly<Record<string, unknown>> | null;
  readonly validation: Readonly<Record<string, unknown>> | null;
  readonly width: number | null;
}

/** Why an entry cannot be committed, with the property it concerns. */
export type FieldProblemCode =
  | 'emptyKey'
  | 'duplicateKey'
  | 'unknownKind'
  | 'assigneeNotRole'
  | 'optionsNeeded'
  | 'emptyOptionId'
  | 'duplicateOption'
  | 'badLimit'
  | 'badWidth'
  | 'badJson';

export interface FieldProblem {
  readonly property: FieldProperty;
  readonly code: FieldProblemCode;
}

/** What the draft is checked against: the other fields' keys and the document's role identifiers. */
export interface FieldContext {
  readonly otherKeys: readonly string[];
  readonly roles: readonly string[];
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

function limitOf(value: unknown): number | null | 'bad' {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && DECIMAL.test(value) ? Number(value) : 'bad';
}

function countOf(value: unknown): number | null | 'bad' {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 'bad';
}

/**
 * Every reason the draft cannot be committed (FRW-073 criterion 2). Empty when it can. The check is
 * the panel's gate: a draft with a problem is shown with its reasons and not committed.
 */
export function validateFieldDraft(draft: FieldDraft, ctx: FieldContext): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const add = (property: FieldProperty, code: FieldProblemCode) =>
    problems.push({ property, code });

  if (draft.key.trim() === '') add('key', 'emptyKey');
  else if (ctx.otherKeys.includes(draft.key)) add('key', 'duplicateKey');

  if (!(FIELD_KINDS as readonly string[]).includes(draft.kind)) add('kind', 'unknownKind');

  if (draft.assignee !== null && !ctx.roles.includes(draft.assignee))
    add('assignee', 'assigneeNotRole');

  if (draft.kind === 'choice' && draft.options.length === 0) add('options', 'optionsNeeded');
  const seen = new Set<string>();
  for (const option of draft.options) {
    if (option.id.trim() === '') add('options', 'emptyOptionId');
    else if (seen.has(option.id)) add('options', 'duplicateOption');
    seen.add(option.id);
  }

  const v = draft.validation ?? {};
  const min = limitOf(v['min']);
  const max = limitOf(v['max']);
  const minLength = countOf(v['minLength']);
  const maxLength = countOf(v['maxLength']);
  if (min === 'bad' || max === 'bad' || minLength === 'bad' || maxLength === 'bad')
    add('validation', 'badLimit');
  else if (
    (min !== null && max !== null && min > max) ||
    (minLength !== null && maxLength !== null && minLength > maxLength)
  )
    add('validation', 'badLimit');

  if (draft.width !== null && !(Number.isFinite(draft.width) && draft.width > 0))
    add('width', 'badWidth');

  return problems;
}

/** A draft commits only when it has no problem. */
export function canCommitField(problems: readonly FieldProblem[]): boolean {
  return problems.length === 0;
}

/** Canonical JSON with sorted keys, so that the same content compares equal in any key order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * The attributes that changed between the field as it was and the draft, and only those (FRW-073
 * criterion 3): the commit is one attribute change per property that differs.
 */
export function fieldPatch(
  before: FieldDraft,
  after: FieldDraft,
): Partial<Pick<FieldDraft, FieldProperty>> {
  const patch: Record<string, unknown> = {};
  for (const property of FIELD_PROPERTIES)
    if (canonical(before[property]) !== canonical(after[property]))
      patch[property] = after[property];
  return patch as Partial<Pick<FieldDraft, FieldProperty>>;
}

/**
 * Whether the panel is read-only (FRW-073 criterion 4): without `edit`, or while the workflow is
 * `sent` or `in_progress`. Any other state (or none) leaves it editable for a user with `edit`.
 */
export function fieldPanelReadOnly(canEdit: boolean, workflow: string | null): boolean {
  return !canEdit || workflow === 'sent' || workflow === 'in_progress';
}
