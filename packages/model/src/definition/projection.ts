/**
 * What exists only in a reader's projection of a document (ADR 0019, proposed; spike S12; CDM-053):
 * the `hidden_region` placeholder that stands for a region the reader may not see, and the
 * redaction marker that stands for a field value the reader may not read. A stored document or a
 * commit never contains either; `model.validate()` refuses both (I1).
 *
 * The projection schema is the CDM schema plus the nodes here (`projectionSchema()` in
 * `@docedit/model/prosemirror`; published as spec/cdm/cdm-1.projection.json).
 */
import type { JsonValue, ProjectionNodeDef } from './grammar.ts';
import { attr, nullable, str } from './grammar.ts';
import { NODE_ID } from './shared.ts';

export const HIDDEN_REGION: ProjectionNodeDef = {
  name: 'hidden_region',
  atom: true,
  selectable: true,
  allowedIn: ['body'],
  spec: 'ADR 0019; CDM-053',
  doc: 'Placeholder for a region the reader may not see: a block atom in the body, selectable whole, with no position inside it. Only in projections.',
  attrs: {
    id: attr(NODE_ID, null, 'Identifier of the hidden region.', { presence: 'required' }),
    title: attr(
      nullable(str(255)),
      null,
      'Title of the hidden region, or null when the title is hidden too.',
    ),
  },
};

/** The marker that replaces a value a reader may not read (ADR 0019). */
export const REDACTION_MARKER: Readonly<{ redacted: true }> = Object.freeze({ redacted: true });

/** A fresh copy of the marker, for code that builds documents. */
export function redactionMarker(): { redacted: true } {
  return { redacted: true };
}

/**
 * Whether a value is, or claims to be, the redaction marker: an object whose `redacted` member is
 * `true`. Extra members do not make it anything else, so a crafted variant is refused as well.
 */
export function isRedactionMarker(value: JsonValue | undefined): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'redacted') &&
    value['redacted'] === true
  );
}

/** The attributes of a form field that a projection redacts (ADR 0019). */
export const REDACTED_FIELD_ATTRIBUTES: readonly string[] = ['value', 'default'];
