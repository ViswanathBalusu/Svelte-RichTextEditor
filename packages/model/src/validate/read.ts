/**
 * Reading a CDM document (03 §2, §11.1; CDM-009). A reader that lacks a feature MUST refuse the
 * document with a clear message and MUST NOT open it and drop what it does not understand. A
 * ProseMirror-based reader throws on unknown node types and marks, so the envelope's version and
 * `requires` are checked before anything is parsed.
 *
 * The refusal codes are the DEP codes `unsupported_cdm` and `unsupported_feature` (05 §5.8). A
 * document that fails validation is refused with `validation_failed` and the list of violations;
 * how a surface reports it (a channel rejection, a REST problem) is the protocol's (PRO-023).
 */
import type { Node as PMNode, Schema } from 'prosemirror-model';
import type { JsonEnvelope, JsonNode } from '../canonical/canonical-form.ts';
import { CDM1 } from '../definition/cdm1.ts';
import type { CdmDefinition } from '../definition/grammar.ts';
import { buildSchema, cdmSchema } from '../prosemirror/index.ts';
import { type ValidationContext, type Violation, validate } from './validate.ts';

export interface ReadOptions extends Omit<ValidationContext, 'def' | 'schema'> {
  def?: CdmDefinition;
  /** The schema to parse with; defaults to the schema of `def`. */
  schema?: Schema;
  /** The features this reader understands; defaults to every feature of the definition. */
  features?: readonly string[];
}

/** The `cdm` major versions a reader of this package supports. */
export interface SupportedVersions {
  min: number;
  max: number;
}

export type ReadResult =
  | { ok: true; cdm: number; requires: string[]; doc: PMNode; notChecked: string[] }
  | {
      ok: false;
      code: 'unsupported_cdm';
      message: string;
      version: unknown;
      supported: SupportedVersions;
    }
  | { ok: false; code: 'unsupported_feature'; message: string; missing: string[] }
  | { ok: false; code: 'validation_failed'; message: string; violations: Violation[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** This package reads exactly the major version of its definition. */
export function supportedVersions(def: CdmDefinition = CDM1): SupportedVersions {
  return { min: def.cdm, max: def.cdm };
}

function invalid(violations: Violation[]): ReadResult {
  const head = violations
    .slice(0, 3)
    .map((v) => `${v.invariant} ${v.path || '/'}: ${v.message}`)
    .join('; ');
  const more = violations.length > 3 ? `; and ${violations.length - 3} more` : '';
  return {
    ok: false,
    code: 'validation_failed',
    message: `the document is not valid CDM: ${head}${more}`,
    violations,
  };
}

/**
 * Reads an envelope into a ProseMirror document, or refuses it. Order: the envelope's shape, the
 * major version, the features in `requires` (all before the ProseMirror parser sees anything),
 * then validation (03 §8), then parsing.
 */
export function readDocument(envelope: unknown, opts: ReadOptions = {}): ReadResult {
  const def = opts.def ?? CDM1;
  const supported = supportedVersions(def);
  if (!isObject(envelope))
    return invalid([
      {
        invariant: 'I1',
        code: 'not_an_object',
        path: '',
        nodeId: null,
        message: 'the document is not a JSON object',
      },
    ]);

  const cdm = envelope['cdm'];
  if (typeof cdm !== 'number' || !Number.isSafeInteger(cdm))
    return invalid([
      {
        invariant: 'I1',
        code: 'cdm_version',
        path: '/cdm',
        nodeId: null,
        message: 'cdm must be an integer major version',
      },
    ]);
  if (cdm < supported.min || cdm > supported.max)
    return {
      ok: false,
      code: 'unsupported_cdm',
      message: `the document uses CDM version ${cdm}; this reader supports version ${
        supported.min === supported.max ? supported.max : `${supported.min} to ${supported.max}`
      }`,
      version: cdm,
      supported,
    };

  const requires = envelope['requires'];
  if (!Array.isArray(requires) || requires.some((f) => typeof f !== 'string'))
    return invalid([
      {
        invariant: 'I1',
        code: 'requires_invalid',
        path: '/requires',
        nodeId: null,
        message: 'requires must be an array of strings',
      },
    ]);
  const known = new Set(opts.features ?? def.features.map((f) => f.name));
  const missing = [...new Set(requires as string[])].filter((f) => !known.has(f));
  if (missing.length)
    return {
      ok: false,
      code: 'unsupported_feature',
      message: `the document needs ${missing.length === 1 ? 'a feature' : 'features'} this reader does not support: ${missing.join(', ')}`,
      missing,
    };

  const schema = opts.schema ?? (def === CDM1 ? cdmSchema() : buildSchema(def));
  const { def: _d, schema: _s, features: _f, ...context } = opts;
  const result = validate(envelope, { ...context, def, schema });
  if (!result.valid) return invalid(result.violations);
  return {
    ok: true,
    cdm,
    requires: [...(requires as string[])],
    doc: schema.nodeFromJSON(envelope['doc']),
    notChecked: result.notChecked,
  };
}

/** Writes a document back as an envelope (03 §2). */
export function writeDocument(
  doc: PMNode,
  requires: readonly string[],
  def: CdmDefinition = CDM1,
): JsonEnvelope {
  return { cdm: def.cdm, requires: [...requires], doc: doc.toJSON() as JsonNode };
}
