/**
 * The published artifacts of the model, as text (CDM-007, CDM-008). The generate script writes them
 * under spec/cdm; a test regenerates them and fails when the files differ (byte equality in CI).
 */
import { canonicalize } from '../canonical/jcs.ts';
import { sha256Hex } from '../canonical/hash.ts';
import type { CdmDefinition } from '../definition/grammar.ts';
import { generateDocs } from './docs.ts';
import { generateJsonSchema } from './json-schema.ts';
import { generateProjectionSpec, generateProseMirrorSpec } from './prosemirror-spec.ts';
import { generateTypes } from './typescript.ts';
import { generateWriterSupportDocs, generateWriterSupportJson } from './writer-support-docs.ts';
import { MODEL_CODES } from '../validate/built-in.ts';

/** The stable violation codes, by invariant (CDM-013): what other implementations report. */
function violationCodes(def: CdmDefinition): unknown {
  const codes = Object.entries(MODEL_CODES)
    .map(([code, c]) => ({ code, invariant: c.invariant, doc: c.doc }))
    .sort(
      (a, b) =>
        Number(a.invariant.slice(1)) - Number(b.invariant.slice(1)) || (a.code < b.code ? -1 : 1),
    );
  return { cdm: def.cdm, status: def.status, codes };
}

export interface Artifact {
  /** Path relative to the repository root. */
  path: string;
  text: string;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** SHA-256 of the canonical JSON of the ProseMirror schema spec; changes with any node, mark, attribute or mark order (CDM-008). */
export function schemaHash(def: CdmDefinition): Promise<string> {
  return sha256Hex(canonicalize(generateProseMirrorSpec(def)));
}

/** SHA-256 of the canonical JSON of the projection schema spec (ADR 0019; CDM-053). */
export function projectionSchemaHash(def: CdmDefinition): Promise<string> {
  return sha256Hex(canonicalize(generateProjectionSpec(def)));
}

export async function generateArtifacts(def: CdmDefinition): Promise<Artifact[]> {
  const base = `spec/cdm/cdm-${def.cdm}`;
  const files: Artifact[] = [
    { path: `${base}.schema.json`, text: json(generateJsonSchema(def)) },
    { path: `${base}.prosemirror.json`, text: json(generateProseMirrorSpec(def)) },
    { path: `${base}.projection.json`, text: json(generateProjectionSpec(def)) },
    { path: `${base}.attributes.md`, text: generateDocs(def) },
    { path: `${base}.writer-support.md`, text: generateWriterSupportDocs(def) },
    { path: `${base}.writer-support.json`, text: json(generateWriterSupportJson(def)) },
    { path: `${base}.violations.json`, text: json(violationCodes(def)) },
    { path: 'packages/model/src/generated/types.ts', text: generateTypes(def) },
  ];
  const manifest = {
    cdm: def.cdm,
    status: def.status,
    generator: 'packages/model/scripts/generate.ts',
    prosemirrorSchemaHash: await schemaHash(def),
    projectionSchemaHash: await projectionSchemaHash(def),
    files: Object.fromEntries(
      await Promise.all(files.map(async (f) => [f.path, await sha256Hex(f.text)] as const)),
    ),
  };
  files.push({ path: `${base}.manifest.json`, text: json(manifest) });
  return files;
}
