/**
 * The content of a document at an export job's `seq` (09 §1 "CDM at seq N"; EXP-001; EXP-004
 * criterion 7), read from the storage the document service writes: the newest checkpoint at or
 * before `seq` and the stored commits after it, rebuilt with the authority's `contentAt` and its
 * replayers (HIS-005), as the service's own content reads do. A snapshot commit (BE-037) restarts
 * from the checkpoint stored at its `seq`. Reading storage directly means the worker needs no
 * service credential and no HTTP route; every read names the job's tenant (BE-049 criterion 5).
 */
import { contentAt as rebuild, defaultReplayers } from '@docedit/authority';
import type { CheckpointStore, DocRef, DocumentStore, LogStore } from '@docedit/document-service';
import { JobFailure } from '@docedit/document-service';
import type { CdmEnvelope } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';

export interface ContentStores {
  logs: Pick<LogStore, 'head' | 'read'>;
  checkpoints: Pick<CheckpointStore, 'latest' | 'get'>;
  documents: Pick<DocumentStore, 'get'>;
  /**
   * The hash of the stored commit at a `seq` (lower-case hex), or null: the chain head of that
   * state (HIS-034 criterion 3). Absent: the manifest names no chain head.
   */
  chainHeadAt?: (ref: DocRef, seq: number) => Promise<string | null>;
}

/** The chain head of the state at `seq`, or null when the stores do not offer it (HIS-034). */
export async function chainHeadOf(
  stores: ContentStores,
  ref: DocRef,
  seq: number,
): Promise<string | null> {
  return stores.chainHeadAt ? stores.chainHeadAt(ref, seq) : null;
}

export interface Content {
  envelope: CdmEnvelope;
  /** The document's title (05 §6.2), for the PDF's metadata; the CDM has none (03 §2). */
  title: string | null;
  /** The document's classification label (UX-085; EXP-089), or null when it has none. */
  classification: string | null;
}

/** The content of `ref` at `seq`, for the incarnation the job was created for. */
export async function contentAt(
  stores: ContentStores,
  ref: DocRef,
  incarnation: string,
  seq: number,
): Promise<Content> {
  const record = await stores.documents.get(ref);
  if (!record || record.deletedAt !== null)
    throw new JobFailure('not_found', `document ${ref.doc} no longer exists`);
  const head = await stores.logs.head(ref);
  if (record.incarnation !== incarnation || head.incarnation !== incarnation)
    throw new JobFailure(
      'not_found',
      `document ${ref.doc} was replaced after the export was requested`,
    );
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > head.seq)
    throw new JobFailure('not_found', `document ${ref.doc} has no content at seq ${seq}`);
  const cp = await stores.checkpoints.latest(ref, seq);
  if (!cp)
    throw new JobFailure('internal', `document ${ref.doc} has no checkpoint at or before ${seq}`);
  const schema = cdmSchema();
  const commits = cp.seq < seq ? await stores.logs.read(ref, cp.seq + 1, seq) : [];
  const snapshots = new Map<number, ReturnType<typeof schema.nodeFromJSON>>();
  for (const c of commits)
    if ((c.kind as string) === 'snapshot') {
      const s = await stores.checkpoints.get(ref, c.seq);
      if (s) snapshots.set(c.seq, schema.nodeFromJSON(s.doc));
    }
  const r = rebuild(seq, {
    incarnation,
    head: head.seq,
    checkpoints: [{ seq: cp.seq, doc: schema.nodeFromJSON(cp.content.doc) }],
    commits: (after, to) => commits.filter((c) => c.seq > after && c.seq <= to),
    resolve: (c) => {
      const n = snapshots.get(c.seq);
      if (!n) throw new Error('no checkpoint holds the snapshot');
      return n;
    },
    replayers: defaultReplayers(schema),
  });
  if (!r.ok)
    throw new JobFailure(
      r.code === 'not_found' ? 'not_found' : 'internal',
      `the content of ${ref.doc} at seq ${seq} cannot be rebuilt`,
    );
  return {
    envelope: {
      cdm: cp.content.cdm,
      requires: [...cp.content.requires],
      doc: r.doc.toJSON(),
    } as unknown as CdmEnvelope,
    title: record.title,
    classification: record.label ?? null,
  };
}

/** The document's language (settings `lang`, 03 §4), or null. */
export function documentLang(envelope: CdmEnvelope): string | null {
  const top = (envelope.doc as { content?: Array<{ type: string; content?: unknown[] }> }).content;
  const defs = top?.find((c) => c.type === 'defs');
  const settings = (
    defs?.content as Array<{ type?: string; attrs?: { lang?: unknown } }> | undefined
  )?.find((d) => d.type === 'settings');
  return typeof settings?.attrs?.lang === 'string' ? settings.attrs.lang : null;
}
