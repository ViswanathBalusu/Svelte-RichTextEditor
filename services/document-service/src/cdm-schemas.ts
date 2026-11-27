/**
 * The schemas of the model versions this process serves (BE-094; ADR 0435). A document is read and
 * written in the schema of its own version: ProseMirror drops the attributes a schema does not
 * declare, so a version 2 document read in the version 1 schema would lose them without an error.
 *
 * Version 1 is always there. A later version exists only when the deployment registers it, which
 * today only tests do (owner decisions 75 and 76: the first version 2 is test-only and nothing of
 * it ships). Nothing here decides which versions a deployment lets channels use; that is the
 * `cdm` setting of the data plane.
 */
import type { CdmDefinition } from '@docedit/model/definition';
import { cdmSchema, projectionSchema } from '@docedit/model/prosemirror';

type Schema = ReturnType<typeof cdmSchema>;

interface Entry {
  readonly schema: Schema;
  readonly projection: Schema;
  readonly definition: CdmDefinition;
}

const registry = new Map<number, Entry>();

/** Makes `version` readable in this process. Returns a function that takes it away again. */
export function registerCdmSchema(
  version: number,
  schema: Schema,
  projection: Schema,
  definition: CdmDefinition,
): () => void {
  if (version === 1) throw new Error('CDM 1 is built in');
  registry.set(version, { schema, projection, definition });
  return () => {
    registry.delete(version);
  };
}

/**
 * The definition the invariants of a version are checked against, or undefined for version 1,
 * which is the room's default.
 */
export function definitionForCdm(version: number): CdmDefinition | undefined {
  if (version === 1) return undefined;
  const e = registry.get(version);
  if (!e) throw new Error(`this process has no definition for CDM ${version}`);
  return e.definition;
}

/** The schema of a model version; throws for a version this process does not serve. */
export function schemaForCdm(version = 1): Schema {
  if (version === 1) return cdmSchema();
  const e = registry.get(version);
  if (!e) throw new Error(`this process has no schema for CDM ${version}`);
  return e.schema;
}

/** The projection schema of a model version (ADR 0019). */
export function projectionSchemaForCdm(version = 1): Schema {
  if (version === 1) return projectionSchema();
  const e = registry.get(version);
  if (!e) throw new Error(`this process has no projection schema for CDM ${version}`);
  return e.projection;
}

/** Whether this process can read documents of `version`. */
export function hasCdmSchema(version: number): boolean {
  return version === 1 || registry.has(version);
}
