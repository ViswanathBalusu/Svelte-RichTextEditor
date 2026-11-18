/**
 * The document model additions of fields (12 §3; FRW-001, FRW-002, FRW-003): role placeholders,
 * field rules and the form field atom. This is FRW's definition module; the one CDM definition
 * (cdm1.ts) imports these nodes and declares none of their attributes itself (CDM-022).
 *
 * Every node here belongs to the feature `fields` (03 §11.1), so a document that uses one lists
 * `fields` in `requires` (I1). The invariants of 12 §3.6 are in src/fields/invariants.ts.
 */
import { DECIMAL_PATTERN } from '../conventions/validators.ts';
import { type NodeDef, arr, attr, bool, int, nullable, obj, oneOf, ref, str } from './grammar.ts';
import {
  COLOUR,
  DEFINITION_ID_PATTERN,
  DEF_ID,
  FIELD_KEY_PATTERN,
  NAME,
  ULENGTH,
  ext,
  id,
} from './shared.ts';

/** The field kinds of version 1 (12 §3.2). */
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
export type FieldKind = (typeof FIELD_KINDS)[number];

/**
 * The width, in twips, of a field that states no `width` (12 §3.2: fields have a fixed width by
 * default; FRW-080 criterion 3). The table is the schema's: the layout, the web view and the PDF
 * export all read it through `fieldWidth`, so a field never takes its width from its value.
 * The figures are a proposed default (docs/adr/0380-w4-FRW-080-default-field-width.md), not a
 * measurement; the owner has not chosen them.
 */
export const FIELD_DEFAULT_WIDTH: Readonly<Record<FieldKind, number>> = {
  text: 2880,
  number: 1440,
  date: 1800,
  checkbox: 288,
  choice: 2880,
  signature: 3600,
  initials: 1440,
  dateSigned: 1800,
  formula: 1440,
};

/** Used for a kind this version does not know (a reserved or future kind). */
const FALLBACK_FIELD_WIDTH = 2880;

/**
 * The width in twips of a field's box: its `width` when it has one, else the default of its kind.
 * The value of the field never enters it.
 */
export function fieldWidth(kind: unknown, width: unknown): number {
  if (typeof width === 'number' && Number.isInteger(width) && width > 0) return width;
  return typeof kind === 'string' && Object.hasOwn(FIELD_DEFAULT_WIDTH, kind)
    ? FIELD_DEFAULT_WIDTH[kind as FieldKind]
    : FALLBACK_FIELD_WIDTH;
}

/** Kinds that 12 §3.2 reserves for a later version; version 1 refuses them (FRW-002). */
export const RESERVED_FIELD_KINDS = ['attachment'] as const;

/** Kinds whose values only server-authored commits set (12 §3.3; rule P8). */
export const SERVER_SET_FIELD_KINDS: readonly FieldKind[] = [
  'signature',
  'initials',
  'dateSigned',
  'formula',
];

/** Kinds a participant may fill (12 §4.2, rule P7): every kind the server does not set. */
export const FILLABLE_FIELD_KINDS: readonly FieldKind[] = FIELD_KINDS.filter(
  (k) => !SERVER_SET_FIELD_KINDS.includes(k),
);

/** The attributes of a form field that a fill may change (12 §4.2, rule P7). */
export const FILL_ATTRIBUTES: readonly string[] = ['value'];

/** How a signature or initials value was adopted (12 §3.3, §8.1). */
export const SIGNATURE_MODES = ['typed', 'drawn', 'uploaded'] as const;

/** The validation presets of 12 §3.2; their definitions are the rules package's (ADR 0030 §8). */
export const VALIDATION_PRESETS = ['email', 'phone', 'postcode'] as const;

/** Limits of 12 §3.6 (I15). */
export const FIELD_LIMITS = {
  /** Form fields in one document. */
  fields: 2000,
  /** Rules in one document. */
  rules: 500,
  /** UTF-8 bytes of a value (a string, or the canonical JSON of any other value). */
  valueBytes: 4096,
} as const;

/**
 * Free JSON for `value` and `default`. The size bound is above 4 KiB so that every value I15
 * allows fits, even text whose every character needs an escape in JSON; I15 then checks the
 * 4 KiB limit and the type of the value for its kind (12 §3.3).
 */
const VALUE = { kind: 'json', maxBytes: 8200, maxDepth: 2, nullable: true } as const;
/**
 * A value of the wrong shape for its kind, a JSON number in a number field included, is I15 (12
 * §3.6), which a fill commit reports as `field_invalid` (12 §4.2, P7): the field invariants check
 * `value` and `default` whole, so no part of them is an I11 grammar problem.
 */
const VALUE_PROBLEMS = { '*': 'I15' } as const;

export const ROLE_DEF: NodeDef = {
  name: 'role_def',
  atom: true,
  selectable: false,
  feature: 'fields',
  spec: '12 §3.1',
  doc: 'A role placeholder such as "Tenant"; fields and regions are assigned to roles, never to people.',
  attrs: {
    id: attr(DEF_ID, null, 'Role identifier; fields match roles by it alone (I13).', {
      presence: 'required',
    }),
    name: attr(NAME, null, 'Role name.', { presence: 'required' }),
    color: attr(COLOUR, null, 'Role colour; always shown with an icon, never alone.', {
      presence: 'required',
    }),
    ext: ext(),
  },
};

export const RULE_DEF: NodeDef = {
  name: 'rule_def',
  atom: true,
  selectable: false,
  feature: 'fields',
  spec: '12 §3.5',
  doc: 'A field rule in the typed JSON rules language (12 §5); the language itself is the rules package (FRW-015).',
  attrs: {
    id: attr(DEF_ID, null, 'Rule identifier.', { presence: 'required' }),
    when: attr({ kind: 'json', maxBytes: 16384, maxDepth: 32 }, null, 'Condition (12 §5).', {
      presence: 'required',
    }),
    then: attr(
      { kind: 'json', maxBytes: 16384, maxDepth: 32 },
      null,
      'Effects when the condition holds.',
      { presence: 'required' },
    ),
    else: attr(
      { kind: 'json', maxBytes: 16384, maxDepth: 32, nullable: true },
      null,
      'Effects otherwise.',
    ),
    ext: ext(),
  },
};

export const FORM_FIELD: NodeDef = {
  name: 'form_field',
  group: 'inline caption_inline',
  inline: true,
  atom: true,
  feature: 'fields',
  spec: '12 §3.2',
  doc: 'A fillable field assigned to a role placeholder; not allowed in headers, footers or footnotes (I10).',
  attrs: {
    id: id(),
    key: attr(
      str(128, { pattern: FIELD_KEY_PATTERN }),
      null,
      'Data label, unique in the document (I13).',
      { presence: 'required' },
    ),
    kind: attr(
      oneOf(FIELD_KINDS),
      'text',
      'Field kind. The kind `attachment` is reserved and refused in version 1 (12 §3.2).',
    ),
    label: attr(NAME, null, 'Accessible name and summary text.', { presence: 'required' }),
    assignee: attr(
      nullable(ref('role')),
      null,
      'Role placeholder that fills it, or null for a field only authors set (I13).',
    ),
    required: attr(bool(), false, 'Static required flag; rules can also require a field.'),
    readOnly: attr(bool(), false, 'Static read-only flag; rules can also disable a field.'),
    value: attr(
      VALUE,
      null,
      'Current value, typed by kind; null means empty (12 §3.3; I15). Signature, initials, date-signed and formula values are set only by the server (P8).',
      { reportAs: VALUE_PROBLEMS },
    ),
    default: attr(VALUE, null, 'Default value, typed like `value`.', { reportAs: VALUE_PROBLEMS }),
    placeholder: attr(nullable(str(255)), null, 'Placeholder text.'),
    options: attr(
      nullable(
        arr(
          obj(
            { id: str(64, { pattern: DEFINITION_ID_PATTERN }), label: NAME },
            { required: ['id', 'label'] },
          ),
          500,
        ),
      ),
      null,
      'Choices of a `choice` field; option identifiers are unique within the field.',
    ),
    format: attr(
      nullable(
        obj({ decimals: int(0, 10), prefix: str(16), suffix: str(16), datePattern: str(32) }),
      ),
      null,
      'Display format: decimals, prefix, suffix, date pattern.',
    ),
    validation: attr(
      nullable(
        obj({
          min: str(64, { pattern: DECIMAL_PATTERN }),
          max: str(64, { pattern: DECIMAL_PATTERN }),
          minLength: int(0, 4096),
          maxLength: int(0, 4096),
          pattern: str(256),
          preset: oneOf(VALIDATION_PRESETS),
        }),
      ),
      null,
      'Static validation: decimal bounds, length bounds in Unicode code points, a restricted pattern (12 §5.2) and a preset.',
    ),
    width: attr(nullable(ULENGTH), null, 'Fixed width in twips, so filling moves no line break.'),
    sensitive: attr(
      bool(),
      false,
      'When true, the value is readable only by the principals of the read rule (ADR 0019, proposed; FRW-088): every other reader gets the redaction marker in place of `value` and `default`.',
    ),
    ext: ext(),
  },
};
