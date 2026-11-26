/**
 * Several versions of the CDM in one process (03 §11.3; CDM-050; owner decisions 58, 75 and 76).
 *
 * A service or a replay holds the readers of version n and of n-1 at once, and history keeps the
 * readers of old formats for as long as it keeps the commits (HIS-045). A `ReaderSet` is that:
 * one definition for each major version, one schema for each, and a `read` that sends an envelope
 * to the reader of the version it names. The definitions share no state. A version the set does
 * not hold is refused with `unsupported_cdm` and the range the set does hold, so an operator can
 * check every node before a version is enabled for a tenant.
 *
 * The set never migrates: it reads a document at the version it was written at (03 §11.3).
 */
import type { Schema } from 'prosemirror-model';
import type { CdmDefinition } from '../definition/grammar.ts';
import { buildSchema } from '../prosemirror/index.ts';
import {
  readDocument,
  type ReadOptions,
  type ReadResult,
  type SupportedVersions,
} from './read.ts';

export interface ReaderSet {
  /** The lowest and the highest major version the set holds. */
  readonly supported: SupportedVersions;
  /** The major versions the set holds, ascending. */
  readonly versions: readonly number[];
  /** The definition of one held version, or undefined. */
  definition(cdm: number): CdmDefinition | undefined;
  /** Reads an envelope with the reader of the version it names. */
  read(envelope: unknown, opts?: Omit<ReadOptions, 'def' | 'schema'>): ReadResult;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A reader for each of the given definitions, which must name distinct major versions. */
export function readerSet(definitions: readonly CdmDefinition[]): ReaderSet {
  if (definitions.length === 0) throw new Error('a reader set needs at least one definition');
  const byVersion = new Map<number, CdmDefinition>();
  for (const def of definitions) {
    if (byVersion.has(def.cdm)) throw new Error(`two definitions name CDM version ${def.cdm}`);
    byVersion.set(def.cdm, def);
  }
  const versions = [...byVersion.keys()].sort((a, b) => a - b);
  const supported: SupportedVersions = { min: versions[0]!, max: versions[versions.length - 1]! };
  // One schema for each version, built when that version is first read.
  const schemas = new Map<number, Schema>();
  const schemaOf = (def: CdmDefinition): Schema => {
    let s = schemas.get(def.cdm);
    if (!s) schemas.set(def.cdm, (s = buildSchema(def)));
    return s;
  };
  return {
    supported,
    versions,
    definition: (cdm) => byVersion.get(cdm),
    read(envelope, opts = {}) {
      const cdm = isObject(envelope) ? envelope['cdm'] : undefined;
      const def = typeof cdm === 'number' ? byVersion.get(cdm) : undefined;
      if (def) return readDocument(envelope, { ...opts, def, schema: schemaOf(def) });
      // A version this set does not hold, or an envelope with no readable version: the reader of
      // the newest version words the refusal, with this set's range.
      const newest = byVersion.get(supported.max)!;
      const refused = readDocument(envelope, { ...opts, def: newest, schema: schemaOf(newest) });
      if (!refused.ok && refused.code === 'unsupported_cdm')
        return {
          ...refused,
          message: `the document uses CDM version ${String(cdm)}; this set reads ${versions.join(', ')}`,
          supported,
        };
      return refused;
    },
  };
}
