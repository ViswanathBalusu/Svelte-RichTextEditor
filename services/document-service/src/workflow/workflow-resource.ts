/**
 * The workflow resource as the routes use it (12 §6.1, §10; FRW-025). One workflow per document in
 * version 1. `WorkflowResourceStore` is the port; `MemoryWorkflowResourceStore` is the in-memory
 * store (tests and the memory build) and `PgWorkflowResourceStore` (workflow-resource-pg.ts) the
 * PostgreSQL one. `PUT` carries the revision it read: 0 when the document has no workflow yet, which
 * creates it (docs/adr/0371-w4-FRW-025-workflow-put.md, proposed).
 */
import { uuid7 } from '@docedit/model';
import type { ParticipantDraft, WorkflowInput, WorkflowMembers } from '@docedit/authority';

/** The resource as a read returns it. `etag` is the revision as a quoted string (strong ETag). */
export interface WorkflowResourceView {
  readonly id: string;
  readonly doc: string;
  readonly state: string;
  readonly rev: number;
  readonly etag: string;
  readonly sentSeq: number | null;
  readonly sentHash: string | null;
  readonly timeZone: string;
  readonly participants: readonly (ParticipantDraft & {
    /** Set by the workflow once it runs (12 §7); absent in a draft. */
    readonly state?: string;
    readonly completedSeq?: number;
    /** When the participant first opened the document, ISO 8601 UTC (FRW-031; set once). */
    readonly firstViewedAt?: string;
    /**
     * When the participant became active, ISO 8601 UTC: the anchor of the reminders (FRW-034).
     * Stamped by `recordTransition` each time a participant who was not active becomes so.
ecordTransition each time a participant who was not active becomes so.
     */
    readonly activatedAt?: string;
    /** When a correct access code was submitted for the participant (FRW-039; set once). */
    readonly verifiedAt?: string;
  })[];
  readonly members: WorkflowMembers;
}

export type WorkflowPutProblem =
  | { readonly code: 'workflow_active'; readonly state: string }
  | { readonly code: 'precondition_failed'; readonly rev: number };

export type WorkflowPutResult =
  | { readonly ok: true; readonly resource: WorkflowResourceView; readonly created: boolean }
  | { readonly ok: false; readonly problem: WorkflowPutProblem };

/** What a transition writes besides the new state (12 §6.2 `send`; FRW-030). */
export interface WorkflowTransitionWrite {
  /** The state the workflow moves to. */
  readonly to: string;
  /** Set at the send: the `seq` of the commit and the chain hash at it. */
  readonly sentSeq?: number;
  readonly sentHash?: string;
  /** The participant list as the transition leaves it (the activation marks, `state`). */
  readonly participants?: WorkflowResourceView['participants'];
}

export type WorkflowTransitionResult =
  | { readonly ok: true; readonly resource: WorkflowResourceView }
  | {
      readonly ok: false;
      readonly problem:
        | { readonly code: 'not_found' }
        | { readonly code: 'conflict'; readonly state: string; readonly rev: number };
    };

export interface WorkflowResourceStore {
  /** The resource of a document with its ETag, or null when the document has no workflow. */
  read(tenant: string, doc: string): Promise<WorkflowResourceView | null>;
  /**
   * Writes the resource when `expectedRev` is the stored revision (0: there is none, so it is
   * created in state `draft` at revision 1). A stored workflow that is not `draft` is refused as
   * `workflow_active`, a stale revision (or a second creation) as `precondition_failed`.
   */
  put(
    tenant: string,
    doc: string,
    expectedRev: number,
    input: WorkflowInput,
  ): Promise<WorkflowPutResult>;
  /**
   * Moves the workflow from the state and revision the caller read to `write.to`, and raises the
   * revision. Another state or revision is refused as `conflict`, so two transitions never both
   * apply (FRW-030). One row, one statement: the write is atomic.
   */
  transition(
    tenant: string,
    doc: string,
    from: { readonly state: string; readonly rev: number },
    write: WorkflowTransitionWrite,
  ): Promise<WorkflowTransitionResult>;
  /**
   * The workflows of a tenant that are `sent` or `in_progress`, ordered by document: the ones
   * whose deadline and reminders the scheduled sweep looks at (FRW-034). Reads only.
   */
  listRunning(tenant: string): Promise<readonly WorkflowResourceView[]>;
}

export const etagOfRevision = (rev: number): string => `"${rev}"`;

/** The ETag of a document that has no workflow: the revision 0 that a creating `PUT` carries. */
export const NO_WORKFLOW_ETAG = etagOfRevision(0);

/** The JSON the routes return (`Workflow` of the schema): absent members are left out. */
export function toWire(view: WorkflowResourceView): Record<string, unknown> {
  return {
    id: view.id,
    doc: view.doc,
    state: view.state,
    rev: view.rev,
    ...(view.sentSeq !== null ? { sentSeq: view.sentSeq } : {}),
    ...(view.sentHash !== null ? { sentHash: view.sentHash } : {}),
    timeZone: view.timeZone,
    participants: view.participants,
    ...view.members,
  };
}

/** The in-memory store: the same rules as the PostgreSQL one, kept in a map. */
export class MemoryWorkflowResourceStore implements WorkflowResourceStore {
  readonly #rows = new Map<string, WorkflowResourceView>();

  read(tenant: string, doc: string): Promise<WorkflowResourceView | null> {
    const row = this.#rows.get(`${tenant}/${doc}`);
    return Promise.resolve(row === undefined ? null : structuredClone(row));
  }

  listRunning(tenant: string): Promise<readonly WorkflowResourceView[]> {
    const out: WorkflowResourceView[] = [];
    for (const [key, row] of this.#rows)
      if (key.startsWith(`${tenant}/`) && (row.state === 'sent' || row.state === 'in_progress'))
        out.push(structuredClone(row));
    return Promise.resolve(out.sort((a, b) => (a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : 0)));
  }

  /** A seam for tests: the `send` action (FRW-027) is what changes the state in a real service. */
  setForTest(
    tenant: string,
    doc: string,
    patch: Partial<Pick<WorkflowResourceView, 'state' | 'sentSeq' | 'sentHash' | 'participants'>>,
  ): void {
    const row = this.#rows.get(`${tenant}/${doc}`);
    if (row !== undefined) this.#rows.set(`${tenant}/${doc}`, { ...row, ...patch });
  }

  transition(
    tenant: string,
    doc: string,
    from: { readonly state: string; readonly rev: number },
    write: WorkflowTransitionWrite,
  ): Promise<WorkflowTransitionResult> {
    const key = `${tenant}/${doc}`;
    const row = this.#rows.get(key);
    if (row === undefined) return Promise.resolve({ ok: false, problem: { code: 'not_found' } });
    if (row.state !== from.state || row.rev !== from.rev)
      return Promise.resolve({
        ok: false,
        problem: { code: 'conflict', state: row.state, rev: row.rev },
      });
    const rev = row.rev + 1;
    const next: WorkflowResourceView = {
      ...row,
      state: write.to,
      rev,
      etag: etagOfRevision(rev),
      sentSeq: write.sentSeq ?? row.sentSeq,
      sentHash: write.sentHash ?? row.sentHash,
      participants: structuredClone(write.participants ?? row.participants),
    };
    this.#rows.set(key, next);
    return Promise.resolve({ ok: true, resource: structuredClone(next) });
  }

  put(
    tenant: string,
    doc: string,
    expectedRev: number,
    input: WorkflowInput,
  ): Promise<WorkflowPutResult> {
    const key = `${tenant}/${doc}`;
    const row = this.#rows.get(key);
    const refuse = (problem: WorkflowPutProblem): Promise<WorkflowPutResult> =>
      Promise.resolve({ ok: false, problem });
    if (row !== undefined && row.state !== 'draft')
      return refuse({ code: 'workflow_active', state: row.state });
    if (row === undefined && expectedRev !== 0)
      return refuse({ code: 'precondition_failed', rev: 0 });
    if (row !== undefined && row.rev !== expectedRev)
      return refuse({ code: 'precondition_failed', rev: row.rev });
    const rev = (row?.rev ?? 0) + 1;
    const next: WorkflowResourceView = {
      id: row?.id ?? uuid7(),
      doc,
      state: 'draft',
      rev,
      etag: etagOfRevision(rev),
      sentSeq: null,
      sentHash: null,
      timeZone: input.timeZone,
      participants: structuredClone(input.participants) as ParticipantDraft[],
      members: structuredClone(input.members),
    };
    this.#rows.set(key, next);
    return Promise.resolve({
      ok: true,
      resource: structuredClone(next),
      created: row === undefined,
    });
  }
}
