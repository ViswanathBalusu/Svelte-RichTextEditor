/**
 * The types of inserting a field (03 §7; FE-067 and FE-072). They live apart from `fields-toc.ts`,
 * which imports `frw-072-form-fields.ts`, and that module names these types, so that the two form no
 * cycle.
 *
 * Universal logic over ProseMirror state only: no Node.js or browser API.
 */

export type FieldRefusal =
  | 'bad-kind'
  | 'bad-format'
  | 'not-here'
  | 'not-in-story'
  | 'not-in-body'
  | 'no-date-source'
  | 'bad-date'
  | 'no-feature'
  /** The document already holds the largest number of form fields it may (I15; FRW-072). */
  | 'field-limit'
  | 'read-only';

export type FieldResult =
  | { readonly ok: true; readonly cached: string | null }
  | { readonly ok: false; readonly reason: FieldRefusal };

export interface InsertFieldOptions {
  /** The field's `format`; null or absent is the kind's default. */
  readonly format?: string | null;
  /** For `date`: the server instant (RFC 3339, 01 §8) and the workflow's zone (03 §7). */
  readonly date?: { readonly instant: string; readonly timeZone: string };
  /** For `title`: the document's title, when the caller has one. */
  readonly title?: string | null;
  /** For a form field kind (frw-072-form-fields.ts): true when the document requires `fields`. */
  readonly formFields?: boolean;
  /**
   * True when the caller asks for a form field (the palette of FRW-072). It tells the form kind
   * `date` from the page date of FE-136, which has the same name (proposed, ADR 0367).
   */
  readonly form?: boolean;
  readonly writable: (pos: number) => boolean;
}
