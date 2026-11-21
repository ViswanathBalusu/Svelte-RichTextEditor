/**
 * The visible appearances of a final PDF (12 §12; 09 §7.1, §9.3; FRW-057): what the signing service
 * is asked to draw at each signature and initials field.
 *
 * - The fields come from the document as it stood at `completedSeq` (the job's `seq`): every
 *   `form_field` of kind `signature` or `initials`, with its identifier and key.
 * - The rectangles come from `layout.json` of the final export (`fields`, page and rectangle in
 *   twentieths of a point from the top-left corner). The file is read, checked to be in twips and
 *   of the job's `seq`, and its `fields` are checked by `validateLayout` before any is used; the
 *   signing service checks them again against the page sizes of the compiled PDF.
 * - The text is what the evidence says: for a field with a signing record, `Electronically signed`,
 *   the participant by name (else by identifier) and the date of the signing in UTC; for a field
 *   with none, `Not signed`. It says nothing about who the participant is: a participant's
 *   authentication is as asserted by the host (FRW-058).
 *
 * A layout that cannot be read gives no rectangles, and every field is then reported by the signing
 * service as having none; the seal is not held back (FRW-057 criterion 6).
 */
import { validateLayout } from '@docedit/authority';
import type { JsonNode } from '@docedit/model';
import { objectKeys, type ObjectStore } from '../objects/store.ts';
import type { DocRef } from '../storage/types.ts';
import type { JobRecord } from '../control-plane/jobs/queue.ts';
import type { EvidenceLedger } from './evidence-ledger.ts';
import type { AppearanceRequest } from './signing-client.ts';
import type { WorkflowResourceView } from './workflow-resource.ts';

const KINDS: ReadonlySet<string> = new Set(['signature', 'initials']);

/** The signature and initials fields of a document, in document order. */
export function signatureFieldsOf(doc: JsonNode): Array<{ id: string; key: string; kind: string }> {
  const out: Array<{ id: string; key: string; kind: string }> = [];
  const walk = (n: JsonNode): void => {
    if (n.type === 'form_field') {
      const a = (n.attrs ?? {}) as Record<string, unknown>;
      if (
        typeof a['id'] === 'string' &&
        typeof a['key'] === 'string' &&
        KINDS.has(String(a['kind']))
      )
        out.push({ id: a['id'], key: a['key'], kind: String(a['kind']) });
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return out;
}

const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface AppearanceDeps {
  readonly objects: Pick<ObjectStore, 'get'>;
  readonly content: {
    rebuild(ref: DocRef, incarnation: string, seq: number): Promise<{ doc: JsonNode }>;
  };
  readonly evidence: Pick<EvidenceLedger, 'list'>;
}

export async function appearanceRequestFor(
  deps: AppearanceDeps,
  ref: DocRef,
  workflow: WorkflowResourceView,
  job: JobRecord,
): Promise<AppearanceRequest | undefined> {
  const seq = job.payload['seq'];
  const incarnation = job.payload['incarnation'];
  if (typeof seq !== 'number' || typeof incarnation !== 'string') return undefined;
  const fields = signatureFieldsOf((await deps.content.rebuild(ref, incarnation, seq)).doc);
  if (fields.length === 0) return undefined;

  // The signings: field key to who signed and when.
  const signed = new Map<string, { participant: string; atMs: number }>();
  for (const row of await deps.evidence.list(ref.tenant, ref.doc)) {
    if (row.item !== 'signed') continue;
    const signings = (row.evidence.items as Record<string, unknown> | undefined)?.['signings'];
    if (!Array.isArray(signings)) continue;
    for (const s of signings as Array<{ fieldKey?: unknown; atMs?: unknown }>)
      if (typeof s.fieldKey === 'string' && typeof s.atMs === 'number')
        signed.set(s.fieldKey, { participant: row.participant, atMs: s.atMs });
  }
  const nameOf = (id: string): string => {
    const p = workflow.participants.find((x) => x.id === id) as { name?: string } | undefined;
    return p?.name ?? id;
  };

  const targets = fields.map((f) => {
    const s = signed.get(f.key);
    return {
      ...f,
      lines: s ? ['Electronically signed', nameOf(s.participant), utcDate(s.atMs)] : ['Not signed'],
    };
  });
  return { layout: await layoutFields(deps, ref, job, seq), targets };
}

/** The `fields` of the job's `layout.json`, or an empty layout when it cannot be used. */
async function layoutFields(
  deps: Pick<AppearanceDeps, 'objects'>,
  ref: DocRef,
  job: JobRecord,
  seq: number,
): Promise<Record<string, unknown>> {
  const result = (job.result ?? {}) as { layout?: unknown; from?: unknown };
  if (typeof result.layout !== 'string') return {};
  const owner = typeof result.from === 'string' ? result.from : job.id;
  const bytes = await deps.objects
    .get(objectKeys.exportFile(ref.tenant, owner, result.layout))
    .catch(() => null);
  if (bytes === null) return {};
  let layout: unknown;
  try {
    layout = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
  const o = layout as { unit?: unknown; seq?: unknown; fields?: unknown };
  if (typeof layout !== 'object' || layout === null) return {};
  // The unit and the `seq` are part of what the rectangles mean: another unit, or the layout of
  // another state of the document, is not used.
  if (o.unit !== 'twip' || o.seq !== seq) return {};
  const checked = validateLayout(layout);
  if (!checked.ok) return {};
  return o.fields as Record<string, unknown>;
}
