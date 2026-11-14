/**
 * Patterns, grammars and attribute helpers shared by the modules of the CDM definition (cdm1.ts and
 * the modules it imports: fields.ts, citations.ts, projection.ts). One place, so that a grammar is
 * the same wherever it is used (CDM-002, ADR 0018).
 */
import { NODE_ID_PATTERN } from '../conventions/ids.ts';
import { BCP47_PATTERN, COLOUR_PATTERN } from '../conventions/validators.ts';
import { type AttrDef, type Grammar, attr, int, str } from './grammar.ts';

// ---------------------------------------------------------------------------------------------
// Patterns (ASCII, shared with the JSON Schema).

/** Definition identifiers: reserved built-in names (`Normal`) or random identifiers (03 §4.1). */
export const DEFINITION_ID_PATTERN = '^[A-Za-z0-9_-]{1,64}$';
/** Namespaced `ext` keys: `vendor.example:name` (03 §11.2; CDM-002). */
export const EXT_KEY_PATTERN = '^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$';
/** Form field keys: dotted identifiers such as `tenant.income` (12 §3.2). */
export const FIELD_KEY_PATTERN = '^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)*$';

// ---------------------------------------------------------------------------------------------
// Grammars.

export const NODE_ID = str(16, { pattern: NODE_ID_PATTERN });
export const DEF_ID = str(64, { pattern: DEFINITION_ID_PATTERN });
export const COLOUR = str(7, { pattern: COLOUR_PATTERN });
export const LANG = str(64, { pattern: BCP47_PATTERN });
export const NAME = str(255, { minLength: 1 });
export const TEXT = str(2048);
/** Signed lengths in twips, up to 22 inches either way (indents). */
export const LENGTH = int(-31680, 31680);
/** Unsigned lengths in twips, up to 22 inches. */
export const ULENGTH = int(0, 31680);
export const FONT_SIZE = int(20, 32760);
export const USER = str(255, { minLength: 1 });

/** Free JSON for `ext` (03 §11.2): an object with namespaced keys, integers only, at most 4 KiB. */
export const EXT_GRAMMAR: Grammar = {
  kind: 'json',
  maxBytes: 4096,
  maxDepth: 8,
  keyPattern: EXT_KEY_PATTERN,
  objectOnly: true,
};

export const ext = (): AttrDef =>
  attr(
    EXT_GRAMMAR,
    {},
    'Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2).',
  );

export const id = (what = 'Node identifier; never changes once set (I2).'): AttrDef =>
  attr(NODE_ID, null, what, { presence: 'required' });

/** Depth of preserved element trees: 12 covers every tree spike S11 saw (the deepest was 9). */
export const PRESERVED_DEPTH = 12;
/** Size of a preserved tree in canonical JSON: 16 KiB, 32 KiB for styles (S11: table styles reached 20.7 KiB). */
export const PRESERVED_BYTES = 16384;
export const PRESERVED_STYLE_BYTES = 32768;

export const preserved = (maxBytes = PRESERVED_BYTES): AttrDef =>
  attr(
    { kind: 'elementTree', maxBytes, maxDepth: PRESERVED_DEPTH, nullable: true },
    null,
    'Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11).',
    { feature: 'preserve' },
  );

/**
 * Where an inline atom without an identifier came from in an imported file (spike S11; SR-M10): the
 * fragment asset holding its original element, and the SHA-256 of its modelled attributes at import,
 * so that the DOCX writer can tell an unedited atom from an edited one. I4 checks the fragment.
 */
export const origin = (): AttrDef =>
  attr(
    {
      kind: 'object',
      nullable: true,
      properties: {
        fragment: { kind: 'ref', to: 'asset' },
        hash: { kind: 'string', maxLength: 64, pattern: '^[0-9a-f]{64}$' },
      },
      required: ['fragment', 'hash'],
    },
    null,
    'The fragment of the imported file this atom came from, and the SHA-256 of its modelled attributes at import (spike S11).',
    { feature: 'preserve' },
  );
