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
  })[];
  readonly members: WorkflowMembers;
}

export type WorkflowPutProblem =
  | { readonly code: 'workflow_active'; readonly state: string }
  | { readonly code: 'precondition_failed'; readonly rev: number };

export type WorkflowPutResult =
  | { readonly ok: true; readonly resource: WorkflowResourceView; readonly created: boolean }
  | { readonly ok: false; readonly problem: WorkflowPutProblem };

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

  /** A seam for tests: the `send` action (FRW-027) is what changes the state in a real service. */
  setForTest(
    tenant: string,
    doc: string,
    patch: Partial<Pick<WorkflowResourceView, 'state' | 'sentSeq' | 'sentHash' | 'participants'>>,
  ): void {
    const row = this.#rows.get(`${tenant}/${doc}`);
    if (row !== undefined) this.#rows.set(`${tenant}/${doc}`, { ...row, ...patch });
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
