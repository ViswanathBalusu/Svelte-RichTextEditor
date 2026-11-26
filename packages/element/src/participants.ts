/**
 * The participants list's port over the backend's workflow port (FRW-026; 12 §6.1; ui
 * `ParticipantsService`). The list is read from the workflow resource when the service is made, on
 * `prepare`, and again on each `wf.changed`, so people a host wrote through the API (with its
 * service credential) appear without being entered again. A change is a `PUT` with `If-Match`
 * while the workflow is a draft; a document with no workflow yet is created with the ETag `"0"`
 * (ADR 0371). There is no contact detail anywhere in it: a person is a `sub` and a `name` (13 §3).
 *
 * No DOM: this runs in Node.js tests against a stand-in port.
 */
import { PortError, type Tagged, type WorkflowPort } from '@docedit/protocol';
import type { EditorCore } from '@docedit/engine';
import { uuid7 } from '@docedit/model';
import type {
  ParticipantChangeResult,
  ParticipantInput,
  ParticipantItem,
  ParticipantsService,
} from '@docedit/ui';
import type { WorkflowSendSource } from './workflow-send.ts';

type Workflow = Awaited<ReturnType<WorkflowPort['get']>>['value'];
type Wire = Workflow['participants'][number];

/** What the service needs of the port: the workflow source the send dialog uses. */
export type ParticipantsSource = () => WorkflowSendSource | null;

const KINDS = ['filler', 'signer', 'approver', 'cc'] as const;

const itemOf = (p: Wire): ParticipantItem => ({
  id: p.id,
  name: p.name ?? null,
  sub: p.sub ?? null,
  roles: p.roles,
  kind: p.kind,
  order: p.order,
  state: p.state ?? null,
});

/** The members of the form that are not valid, by name. */
function invalidFields(input: ParticipantInput): string[] {
  const bad: string[] = [];
  if (input.roles.length === 0) bad.push('roles');
  if (!KINDS.includes(input.kind)) bad.push('kind');
  if (!Number.isSafeInteger(input.order) || input.order < 1) bad.push('order');
  if (input.name.trim() === '' && input.sub.trim() === '') bad.push('name');
  return bad;
}

export interface ParticipantsHandle extends ParticipantsService {
  /** Stops following wf.changed. */
  dispose(): void;
}

export function participantsService(
  core: EditorCore,
  source: ParticipantsSource,
): ParticipantsHandle {
  let workflow: Workflow | null = null;
  let etag = '"0"';
  let state: string | null = null;
  let items: readonly ParticipantItem[] = [];
  let itemsKey = '[]';
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const apply = (next: Workflow | null, tag: string): void => {
    workflow = next;
    etag = tag;
    const nextState = next ? next.state : 'draft';
    const nextItems = next ? next.participants.map(itemOf) : [];
    const key = JSON.stringify(nextItems);
    const changed = nextState !== state || key !== itemsKey;
    state = nextState;
    if (key !== itemsKey) {
      itemsKey = key;
      items = nextItems;
    }
    if (changed) notify();
  };

  async function refresh(): Promise<void> {
    const current = source();
    if (!current) return;
    try {
      const { value, etag: tag } = await current.port.get(current.docId);
      apply(value, tag);
    } catch (error) {
      // A document with no workflow resource yet is a draft with nobody bound.
      if (error instanceof PortError && error.code === 'not_found') apply(null, '"0"');
    }
  }

  let stop: (() => void) | undefined;
  const first = source();
  if (first) {
    void refresh();
    stop = first.port.onChange?.(first.docId, () => void refresh());
  }

  const canManage = (): boolean =>
    (core.permissions.get()?.caps as readonly string[] | undefined)?.includes('manage') ?? false;
  const canEdit = (): boolean => canManage() && (state === null || state === 'draft');

  /** Writes a new list of participants. */
  async function write(
    change: (list: readonly Wire[]) => Wire[] | { readonly fields: readonly string[] },
  ): Promise<ParticipantChangeResult> {
    if (!canManage()) return { ok: false, reason: 'forbidden' };
    if (state !== null && state !== 'draft') return { ok: false, reason: 'not_draft' };
    const current = source();
    const put = current?.port.put;
    if (!current || !put) return { ok: false, reason: 'failed' };
    const next = change(workflow?.participants ?? []);
    if (!Array.isArray(next)) return { ok: false, reason: 'invalid', fields: next.fields };
    const body: Workflow = workflow
      ? { ...workflow, participants: next }
      : {
          id: uuid7(),
          doc: current.docId,
          state: 'draft',
          rev: 0,
          participants: next,
        };
    try {
      const done: Tagged<Workflow> = await put.call(current.port, current.docId, body, {
        ifMatch: etag,
      });
      apply(done.value, done.etag);
      return { ok: true };
    } catch (error) {
      if (!(error instanceof PortError)) return { ok: false, reason: 'failed' };
      switch (error.code) {
        case 'forbidden':
          return { ok: false, reason: 'forbidden' };
        case 'workflow_active':
          await refresh();
          return { ok: false, reason: 'not_draft' };
        case 'precondition_failed':
        case 'conflict':
          await refresh();
          return { ok: false, reason: 'stale' };
        case 'validation_failed':
        case 'bad_message':
        case 'field_invalid':
          return { ok: false, reason: 'invalid' };
        default:
          return { ok: false, reason: 'failed' };
      }
    }
  }

  const nextId = (list: readonly Wire[]): string => {
    const used = new Set(list.map((p) => p.id));
    for (let n = list.length + 1; ; n++) if (!used.has(`p${n}`)) return `p${n}`;
  };

  return {
    prepare: refresh,
    participants: {
      get: () => items,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    state: {
      get: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    canEdit: {
      get: canEdit,
      subscribe(listener) {
        listeners.add(listener);
        const stopAccess = core.permissions.subscribe(listener);
        return () => {
          listeners.delete(listener);
          stopAccess();
        };
      },
    },
    save: (input) =>
      write((list) => {
        const bad = invalidFields(input);
        if (bad.length > 0) return { fields: bad };
        const name = input.name.trim();
        const sub = input.sub.trim();
        const old = input.id === undefined ? undefined : list.find((p) => p.id === input.id);
        const member: Wire = {
          ...old,
          id: old?.id ?? nextId(list),
          roles: [...input.roles],
          kind: input.kind,
          order: input.order,
        };
        if (name === '') delete member.name;
        else member.name = name;
        if (sub === '') delete member.sub;
        else member.sub = sub;
        return old ? list.map((p) => (p === old ? member : p)) : [...list, member];
      }),
    remove: (id) =>
      write((list) =>
        list.some((p) => p.id === id) ? list.filter((p) => p.id !== id) : [...list],
      ),
    dispose() {
      stop?.();
      stop = undefined;
    },
  };
}
