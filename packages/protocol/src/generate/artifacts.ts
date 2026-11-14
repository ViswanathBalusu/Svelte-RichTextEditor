/**
 * The published artifacts of DEP, as text (SPK-019; PRO-001 to PRO-003). The generate script
 * writes them under spec/dep; a test regenerates them and fails when a file differs.
 *
 * - spec/dep/dep-1.asyncapi.json   real-time plane (AsyncAPI 3.0)
 * - spec/dep/dep-1.openapi.json    control plane and webhooks (OpenAPI 3.1)
 * - spec/dep/dep-1.schema.json     every shape and message as JSON Schema 2020-12, with `Frame`
 * - spec/dep/webhooks/*.schema.json one JSON Schema per webhook body
 * - spec/dep/dep-1.registry.json   vocabularies: messages, routes, errors, close codes, features, events
 * - spec/dep/dep-1.gaps.json       gaps between the prose and the definitions, and the decisions taken
 * - spec/dep/dep-1.manifest.json   hashes of all of the above and the CDM schema they reference
 * - packages/protocol/src/generated/types.ts
 */
import { canonicalize, sha256Hex } from '@docedit/model';
import type { DepDefinition } from '../definition/extension.ts';
import { webhookEnvelope, webhookType } from '../definition/events.ts';
import { envelopeSchema, generateAsyncApi, messageEnvelopeSchema } from './asyncapi.ts';
import { type JsonSchema, type SchemaOptions, namedSchema, toSchema } from './json-schema.ts';
import { generateOpenApi } from './openapi.ts';
import { reachable } from './reach.ts';
import { generateTypes, payloadTypeName } from './typescript.ts';

export interface Artifact {
  /** Path relative to the repository root. */
  path: string;
  text: string;
}

export interface CdmInput {
  /** Path of the CDM schema relative to the repository root. */
  path: string;
  /** Its exact text, so that the manifest records the hash of the file as published (PRO-003). */
  text: string;
}

const JSON_SCHEMA = 'https://json-schema.org/draft/2020-12/schema';
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const depBase = (def: DepDefinition): string => `spec/dep/dep-${def.major}`;

/** The CDM schema's `$id`, read from its text. */
export function cdmSchemaId(cdm: CdmInput): string {
  const parsed = JSON.parse(cdm.text) as { $id?: unknown };
  if (typeof parsed.$id !== 'string') throw new Error(`${cdm.path} has no $id`);
  return parsed.$id;
}

function standaloneOptions(cdmId: string): SchemaOptions {
  return {
    refBase: '#/$defs/',
    cdmRef: (t) => (t === 'cdm-doc' ? `${cdmId}#/$defs/node.doc` : cdmId),
  };
}

/** Every shape and message of the definition as one JSON Schema 2020-12 document. */
export function generateStandaloneSchema(def: DepDefinition, cdmId: string): JsonSchema {
  const o = standaloneOptions(cdmId);
  const defs: JsonSchema = { Envelope: envelopeSchema() };
  for (const s of def.shapes) defs[s.name] = namedSchema(s, o);
  for (const m of def.messages) {
    const name = payloadTypeName(m);
    if (m.payload && m.payload.kind !== 'ref' && name)
      defs[name] = { title: name, ...toSchema(m.payload, o) };
  }
  for (const m of def.messages) defs[`message.${m.t}`] = messageEnvelopeSchema(m, '#/$defs/');
  defs['Frame'] = {
    title: 'Frame',
    description:
      'One text frame: the envelope, checked against its message type when the type is known. A frame of an unknown type is valid here and is ignored by the receiver (05 §1 rule 3).',
    allOf: [
      { $ref: '#/$defs/Envelope' },
      ...def.messages.map((m) => ({
        if: { properties: { t: { const: m.t } }, required: ['t'] },
        then: { $ref: `#/$defs/message.${m.t}` },
      })),
    ],
  };
  return {
    $schema: JSON_SCHEMA,
    $id: `urn:docedit:dep:${def.major}:${def.status}`,
    title: `DEP ${def.version} shapes and messages${def.status === 'draft' ? ' (draft)' : ''}`,
    description: [
      `JSON Schema for every message, payload and resource body of the Document Editing Protocol ${def.version}, generated from packages/protocol/src/definition (SPK-019).`,
      `Validate a text frame against \`#/$defs/Frame\`, a payload against \`#/$defs/<Name>\`. CDM content refers to the CDM schema by its \`$id\` (${cdmId}), published at spec/cdm.`,
      'No object forbids unknown members: receivers MUST ignore fields they do not know (05 §1 rule 3).',
    ].join('\n'),
    $defs: defs,
  };
}

/** The JSON Schema of one webhook body. */
export function generateWebhookSchema(
  def: DepDefinition,
  hook: DepDefinition['webhooks'][number],
  cdmId: string,
): JsonSchema {
  const o = standaloneOptions(cdmId);
  const shape = webhookEnvelope(hook);
  const out: JsonSchema = {
    $schema: JSON_SCHEMA,
    $id: `urn:docedit:dep:${def.major}:${def.status}:webhook:${webhookType(hook)}`,
    title: webhookType(hook),
    ...toSchema(shape, o),
  };
  const used = reachable(def, [shape]);
  if (used.length) out['$defs'] = Object.fromEntries(used.map((s) => [s.name, namedSchema(s, o)]));
  return out;
}

/** The vocabularies of the definition, for checks against the prose (PRO-117) and for implementers. */
export function generateRegistry(def: DepDefinition): unknown {
  return {
    protocol: def.version,
    status: def.status,
    subprotocol: def.subprotocol,
    engines: def.engines,
    messages: def.messages.map((m) => ({
      t: m.t,
      direction: m.dir,
      channelScoped: m.ch,
      id: m.id,
      re: m.re,
      replies: m.replies ?? [],
      ...(m.feature ? { feature: m.feature } : {}),
      spec: m.spec,
      owner: m.owner,
    })),
    operations: def.operations.map((op) => ({
      operationId: op.operationId,
      method: op.method,
      path: op.path,
      security: op.security,
      ...(op.feature ? { feature: op.feature } : {}),
      ...(op.requires ? { requires: op.requires } : {}),
      ifMatch: op.ifMatch ?? 'none',
      idempotencyKey: op.idempotencyKey === true,
      success: op.success.status,
      spec: op.spec,
      owner: op.owner,
    })),
    errors: def.errors.map((e) => ({
      code: e.code,
      surfaces: e.surfaces,
      retryable: e.retryable,
      clientAction: e.clientAction,
      ...(e.syncAction ? { syncAction: e.syncAction } : {}),
      ...(e.closeCode ? { closeCode: e.closeCode, closeCodeInferred: true } : {}),
      ...(e.httpStatus ? { httpStatus: e.httpStatus } : {}),
    })),
    closeCodes: def.closeCodes,
    features: def.features.map((f) => ({
      name: f.name,
      relayForbidden: f.relayForbidden,
      ...(f.port ? { port: f.port } : {}),
      spec: f.spec,
      owner: f.owner,
    })),
    notifications: def.notifications.map((n) => ({
      type: n.type,
      resource: n.resource,
      spec: n.spec,
    })),
    webhooks: def.webhooks.map((w) => ({
      type: webhookType(w),
      when: w.when,
      spec: w.spec,
      owner: w.owner,
    })),
  };
}

export async function generateArtifacts(def: DepDefinition, cdm: CdmInput): Promise<Artifact[]> {
  const base = depBase(def);
  const cdmId = cdmSchemaId(cdm);
  const relCdm = `../${cdm.path.replace(/^spec\//, '')}`;
  const files: Artifact[] = [
    { path: `${base}.asyncapi.json`, text: json(generateAsyncApi(def, relCdm)) },
    { path: `${base}.openapi.json`, text: json(generateOpenApi(def, relCdm)) },
    { path: `${base}.schema.json`, text: json(generateStandaloneSchema(def, cdmId)) },
    ...def.webhooks.map((w) => ({
      path: `spec/dep/webhooks/${webhookType(w)}.schema.json`,
      text: json(generateWebhookSchema(def, w, cdmId)),
    })),
    { path: `${base}.registry.json`, text: json(generateRegistry(def)) },
    {
      path: `${base}.gaps.json`,
      text: json({ protocol: def.version, gaps: def.gaps, decisions: def.decisions }),
    },
    { path: 'packages/protocol/src/generated/types.ts', text: generateTypes(def) },
  ];
  const manifest = {
    protocol: def.version,
    status: def.status,
    subprotocol: def.subprotocol,
    generator: 'packages/protocol/scripts/generate.ts',
    definitionHash: await sha256Hex(canonicalize(JSON.parse(JSON.stringify(def)))),
    cdm: {
      min: def.cdm.min,
      max: def.cdm.max,
      schema: cdm.path,
      id: cdmId,
      sha256: await sha256Hex(cdm.text),
    },
    counts: {
      messages: def.messages.length,
      operations: def.operations.length,
      webhooks: def.webhooks.length,
      notifications: def.notifications.length,
      errors: def.errors.length,
      gaps: def.gaps.length,
      decisions: def.decisions.length,
    },
    files: Object.fromEntries(
      await Promise.all(files.map(async (f) => [f.path, await sha256Hex(f.text)] as const)),
    ),
  };
  files.push({ path: `${base}.manifest.json`, text: json(manifest) });
  return files;
}
