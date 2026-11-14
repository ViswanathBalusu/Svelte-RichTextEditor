/**
 * Counts of fill mode (FRW-076, FRW-078): the bar's "n of m" and the summary are computed from the
 * same list, so they always agree (FRW-078 criterion 4). Only the participant's own fields count
 * (`ownFields`, FRW-077): a field of another role or with no assignee is read-only for them, so the
 * bar never leads to it and the summary never lists it as left to fill.
 */
import type { FillField, FillSummary } from '../core-api.ts';
import type { StringKey } from '../i18n/en-GB.ts';
import { ownFields } from './fields.ts';

export interface FillProgress {
  /** Required fields filled and valid. */
  readonly done: number;
  /** Required fields in all. */
  readonly total: number;
  /** The first required field, in document order, that is empty or invalid. */
  readonly next: FillField | null;
  /** Required fields still empty, and fields whose value is invalid: what is left. */
  readonly left: readonly FillField[];
}

export function fillProgress(summary: FillSummary): FillProgress {
  const mine = ownFields(summary);
  const required = mine.filter((f) => f.required);
  const left = mine.filter((f) => (f.required && !f.filled) || f.invalid !== null);
  return {
    done: required.filter((f) => f.filled && f.invalid === null).length,
    total: required.length,
    next: required.find((f) => !f.filled || f.invalid !== null) ?? null,
    left,
  };
}

/** Why a field is listed in the summary. */
export function fillReasonKey(field: FillField): StringKey {
  if (field.invalid === null) return 'fill.why.required';
  if (field.invalid === 'format') return 'fill.why.format';
  if (field.invalid === 'range') return 'fill.why.range';
  if (field.invalid === 'required') return 'fill.why.required';
  return 'fill.why.other';
}
