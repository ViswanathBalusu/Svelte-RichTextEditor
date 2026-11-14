/**
 * `@docedit/model/prosemirror`: the runtime ProseMirror schema of the CDM (CDM-008), built from the
 * same data as the published artifact spec/cdm/cdm-1.prosemirror.json.
 */
import { type MarkSpec, type NodeSpec, Schema } from 'prosemirror-model';
import { CDM1 } from '../definition/cdm1.ts';
import type { CdmDefinition } from '../definition/grammar.ts';
import {
  generateProjectionSpec,
  generateProseMirrorSpec,
  type ProseMirrorSchemaJson,
} from '../schema/prosemirror-spec.ts';

export type { ProseMirrorSchemaJson } from '../schema/prosemirror-spec.ts';

export interface RenderHooks {
  /** Adds rendering (toDOM, parseDOM, leafText) to a node spec; must not change content, marks or attrs. */
  node?: (name: string, spec: NodeSpec) => NodeSpec;
  mark?: (name: string, spec: MarkSpec) => MarkSpec;
}

/** Builds a ProseMirror schema from the published spec data, optionally with rendering hooks. */
export function schemaFromSpec(spec: ProseMirrorSchemaJson, hooks: RenderHooks = {}): Schema {
  const nodes: Record<string, NodeSpec> = {};
  for (const [name, s] of spec.nodes) {
    const base: NodeSpec = { ...(s as NodeSpec) };
    nodes[name] = hooks.node ? hooks.node(name, base) : base;
  }
  const marks: Record<string, MarkSpec> = {};
  for (const [name, s] of spec.marks) {
    const base: MarkSpec = { ...(s as MarkSpec) };
    marks[name] = hooks.mark ? hooks.mark(name, base) : base;
  }
  return new Schema({ nodes, marks, topNode: spec.topNode });
}

export function buildSchema(def: CdmDefinition = CDM1, hooks: RenderHooks = {}): Schema {
  return schemaFromSpec(generateProseMirrorSpec(def), hooks);
}

let defaultSchema: Schema | undefined;

/** The CDM 1 schema without rendering: what the authority and tests apply steps against. */
export function cdmSchema(): Schema {
  defaultSchema ??= buildSchema(CDM1);
  return defaultSchema;
}

/**
 * The projection schema of a definition (ADR 0019; CDM-053): the CDM schema plus the nodes that
 * only projections contain, such as `hidden_region`. Published as spec/cdm/cdm-1.projection.json.
 */
export function buildProjectionSchema(def: CdmDefinition = CDM1, hooks: RenderHooks = {}): Schema {
  return schemaFromSpec(generateProjectionSpec(def), hooks);
}

let defaultProjectionSchema: Schema | undefined;

/** The CDM 1 projection schema without rendering: what a reader's projection is built in. */
export function projectionSchema(): Schema {
  defaultProjectionSchema ??= buildProjectionSchema(CDM1);
  return defaultProjectionSchema;
}
