/**
 * Repair of a broken document with an audited commit (06 §11; 04 §10; 07 §11; BE-090).
 *
 * The procedure (see `services/document-service/docs/repair-procedure.md`) never edits the log. It
 * takes the content at the head as the log replays from the newest checkpoint that still verifies
 * (BE-081), and writes that content as a server-authored snapshot commit with origin `repair`,
 * through the outbox, so the room applies it under the same checks as any commit (BE-039). History
 * stays where it is; the repair is one more commit on top of it.
 *
 * - `planRepair` is the dry run: it reads and computes, and changes nothing (criterion 4).
 * - `enqueueRepair` writes the outbox item and an audit event that names the operator, the document
 *   and the reason (criterion 3). The reason is operator text: it is kept in the audit event, never
 *   in the commit, whose origin is the registry's `repair` only.
 *
 * An approved region is not checked here: the room refuses a snapshot that would change one, as it
 * refuses any commit (07 §11; test/data-plane/be-090-w5-approved-region.test.ts). Not built here: a
 * replay across a snapshot commit above the chosen checkpoint, which `planRepair` refuses so that an
 * operator repairs that case by hand.
 */
import { isSnapshot } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { derivedCommitId } from './commit-id.ts';
import type {
  AuditEvent,
  AuditStore,
  DocRef,
  NewOutboxItem,
  OutboxItem,
  OutboxStore,
} from '../storage/types.ts';
import { rebuild, verifyCheckpoint, type RecoveryStores } from './recovery.ts';
import { checkpoint as replay, type Encoded } from './tasks.ts';

export interface RepairPlan {
  ref: DocRef;
  operator: string;
  reason: string;
  /** The seq of the head before the repair. */
  head: number;
  /** The newest checkpoint at or before the head that verifies (BE-081), the replay starts there. */
  from: number;
  /** SHA-256 of the content at the head as the log stands, or `unreadable` when a replay fails. */
  currentHash: string;
  /** SHA-256 of the content the repair writes. */
  targetHash: string;
  /** Whether the repair changes the content. */
  changes: boolean;
  /** The canonical envelope the repair commit carries, compressed (the outbox payload). */
  payload: Uint8Array;
}

/**
 * The newest checkpoint at or before the head that verifies. Walks down through the checkpoints the
 * store holds, so a damaged checkpoint is skipped and the replay starts from an earlier good one.
 */
async function newestGood(stores: RecoveryStores, ref: DocRef, head: number): Promise<number> {
  let at = head;
  while (at >= 0) {
    const cp = await stores.checkpoints.latest(ref, at);
    if (!cp) break;
    if ((await verifyCheckpoint(stores, ref, cp.seq)).ok) return cp.seq;
    at = cp.seq - 1;
  }
  throw new Error(
    'no checkpoint verifies at or before the head: the document cannot be repaired from its log',
  );
}

/**
 * The dry run of BE-090: the content at the head as the log replays from the newest good checkpoint,
 * and the hash it has now against the hash the repair writes. Changes nothing.
 */
export async function planRepair(
  stores: RecoveryStores,
  ref: DocRef,
  opts: { operator: string; reason: string },
): Promise<RepairPlan> {
  if (!opts.operator || !opts.reason) throw new Error('the operator and the reason are required');
  const head = (await stores.logs.head(ref)).seq;
  const from = await newestGood(stores, ref, head);
  const base = await stores.checkpoints.get(ref, from);
  if (!base) throw new Error(`no checkpoint at ${from}`);
  const log = head > from ? await stores.logs.read(ref, from + 1, head) : [];
  if (log.length !== head - from) throw new Error('the log has a gap above the checkpoint');
  if (log.some((c) => isSnapshot(c)))
    throw new Error('the log holds a snapshot above the checkpoint: this repair is done by hand');
  const target: Encoded = replay({
    base: { doc: base.doc },
    cdm: base.cdm,
    requires: base.requires,
    commits: log.map((c) => c.steps),
  });
  let currentHash: string;
  try {
    currentHash = (await rebuild(stores, ref)).hash;
  } catch {
    currentHash = 'unreadable';
  }
  return {
    ref,
    operator: opts.operator,
    reason: opts.reason,
    head,
    from,
    currentHash,
    targetHash: target.hash,
    changes: currentHash !== target.hash,
    payload: target.encoded,
  };
}

/**
 * Writes the repair as a snapshot item for the outbox (origin `repair`, BE-039) and records the audit
 * event. Refuses a plan that changes nothing. Returns the item the outbox holds.
 */
export async function enqueueRepair(opts: {
  plan: RepairPlan;
  outbox: OutboxStore;
  audit: AuditStore;
  now?: () => number;
}): Promise<OutboxItem> {
  const { plan } = opts;
  if (!plan.changes) throw new Error('the document is not broken: the repair would change nothing');
  // Deterministic (SYN-030 criterion 3): a repair of this head to this content is one request.
  const commitId = derivedCommitId(
    'repair',
    plan.ref.tenant,
    plan.ref.doc,
    String(plan.head),
    plan.targetHash,
  );
  const item: NewOutboxItem = {
    tenant: plan.ref.tenant,
    doc: plan.ref.doc,
    commitId,
    kind: 'snapshot',
    request: { reason: 'repair', actor: 'system', preconditions: { head: plan.head } },
    payload: plan.payload,
  };
  const stored = await opts.outbox.enqueue(item);
  const event: AuditEvent = {
    id: uuid7(),
    tenant: plan.ref.tenant,
    doc: plan.ref.doc,
    actor: plan.operator,
    kind: 'repair.enqueued',
    data: {
      reason: plan.reason,
      commit: commitId,
      head: plan.head,
      from: plan.from,
      targetHash: plan.targetHash,
    },
    at: (opts.now ?? Date.now)(),
  };
  await opts.audit.record([event]);
  return stored;
}
