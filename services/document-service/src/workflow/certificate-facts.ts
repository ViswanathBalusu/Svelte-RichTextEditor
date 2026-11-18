/**
 * The facts of the certificate of completion, from the evidence the service holds (12 §8.2 step 1;
 * FRW-050; docs/adr/0400-w4-FRW-050-certificate-pages.md, proposed).
 *
 * `certificateFactsOf` reads the evidence rows of a document and the workflow, and gives the
 * checked facts (`buildCertificateFacts` of @docedit/authority) that go into the final export job.
 * The export worker prints them through the converter's typed emitters; nothing here typesets.
 *
 * - The events of a participant come from their evidence rows: `viewed` (`viewedAtMs`), `consent`
 *   (the acceptance time), `signed` (one for each signing) and `completed` (`completedAtMs`), all
 *   server times. Nothing the client said is used. A participant who did nothing has no events.
 * - The address and the user agent are those of the row, and are dropped whole when the tenant's
 *   capture setting is off now (`captureSettings`), whatever the rows stored earlier.
 * - A participant is shown by `name` when the workflow gives one, else by identifier. The service
 *   holds no contact detail (FRW-026).
 */
import {
  buildCertificateFacts,
  DEFAULT_CAPTURE_SETTINGS,
  type CaptureSettings,
  type CertificateEventInput,
  type CertificateFacts,
} from '@docedit/authority';
import type { StoredEvidence } from './evidence-ledger.ts';
import type { WorkflowResourceView } from './workflow-resource.ts';

const asMs = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function eventsOf(row: StoredEvidence): CertificateEventInput[] {
  const items = row.evidence.items as Record<string, unknown>;
  const network: { ipAddress?: string; userAgent?: string } = {};
  if (typeof row.evidence.ipAddress === 'string') network.ipAddress = row.evidence.ipAddress;
  if (typeof row.evidence.userAgent === 'string') network.userAgent = row.evidence.userAgent;
  const out: CertificateEventInput[] = [];
  const at = (kind: CertificateEventInput['kind'], ms: number | null) => {
    if (ms !== null) out.push({ kind, serverTimeMs: ms, ...network });
  };
  if (row.item === 'viewed') at('viewed', asMs(items['viewedAtMs']));
  else if (row.item === 'consent')
    at('consent', asMs((items['consent'] as { atMs?: unknown } | undefined)?.atMs));
  else if (row.item === 'signed')
    for (const s of (items['signings'] as Array<{ atMs?: unknown }> | undefined) ?? [])
      at('signed', asMs(s.atMs));
  else if (row.item === 'completed') at('completed', asMs(items['completedAtMs']));
  return out;
}

export function certificateFactsOf(input: {
  readonly workflow: WorkflowResourceView;
  readonly rows: readonly StoredEvidence[];
  readonly completedSeq: number;
  /** Lower-case hexadecimal SHA-256 of the chain head at completion. */
  readonly chainHead: string;
  readonly captureSettings?: CaptureSettings | undefined;
}): CertificateFacts {
  const { workflow, rows } = input;
  return buildCertificateFacts({
    documentId: workflow.doc,
    workflowId: workflow.id,
    sentSeq: workflow.sentSeq ?? 0,
    completedSeq: input.completedSeq,
    chainHeadHash: input.chainHead,
    captureSettings: input.captureSettings ?? DEFAULT_CAPTURE_SETTINGS,
    participants: workflow.participants.map((p) => ({
      id: p.id,
      label: p.name ?? p.id,
      events: rows.filter((r) => r.participant === p.id).flatMap(eventsOf),
    })),
  });
}
