/**
 * The send dialog's service over the core and the backend's workflow port (FRW-028; 12 §6.2, §10;
 * ui `WorkflowSendService`). The editor's own checks are the authority's `sendChecklist` over the
 * document as the reader holds it (`core.sendChecklist`), given the participants the workflow
 * resource lists. The state and the participants are read with `refresh`, which the dialog calls
 * each time it opens, and again after a send.
 *
 * A send the server refuses for the checklist (`validation_failed` or `pending_suggestions`) comes
 * back as the server's own failures, read from the violations of the problem, so the dialog can
 * show the server's verdict. No DOM: this runs in Node.js tests against a stand-in port.
 *
 * The workflow is read when the service is made and again on each `wf.changed` the port reports, so the
 * lock banner (FRW-029 criterion 6) follows it. `dispose` stops following.
 */
import { PortError, type WorkflowPort } from '@docedit/protocol';
import type { EditorCore } from '@docedit/engine';
import type {
  WorkflowParticipantView,
  WorkflowSendOutcome,
  WorkflowSendService,
} from '@docedit/ui';
import { failuresFromViolations, type SendFailure } from '@docedit/ui/send-checklist';

/** What the service needs of the session: the port and the document it is for. */
export interface WorkflowSendSource {
  readonly port: Pick<WorkflowPort, 'get' | 'act'> &
    Partial<Pick<WorkflowPort, 'onChange' | 'participant' | 'put'>>;
  readonly docId: string;
}

function violationsOf(error: PortError): readonly { readonly path: string }[] {
  const list: unknown = error.details?.['violations'];
  if (!Array.isArray(list)) return [];
  return list.filter(
    (v): v is { path: string } =>
      typeof v === 'object' && v !== null && typeof (v as { path?: unknown }).path === 'string',
  );
}

/** The outcome a rejected `send` stands for. */
export function refusal(error: unknown): WorkflowSendOutcome {
  if (!(error instanceof PortError)) return { ok: false, reason: 'failed' };
  switch (error.code) {
    case 'forbidden':
      return { ok: false, reason: 'forbidden' };
    case 'conflict':
    case 'workflow_active':
      return { ok: false, reason: 'not_draft' };
    case 'validation_failed':
    case 'pending_suggestions': {
      const failures = failuresFromViolations(violationsOf(error));
      if (failures.length > 0) return { ok: false, reason: 'checklist_failed', failures };
      // The server named no suggestion: it is still a failed check, so the list shows it.
      if (error.code === 'pending_suggestions')
        return {
          ok: false,
          reason: 'checklist_failed',
          failures: [{ code: 'pending_suggestions', suggestionIds: [null] }],
        };
      return { ok: false, reason: 'failed' };
    }
    default:
      return { ok: false, reason: 'failed' };
  }
}

export function workflowSendService(
  core: EditorCore,
  source: () => WorkflowSendSource | null,
): WorkflowSendService {
  let state: string | null = null;
  let participants: readonly { readonly roles: readonly string[] }[] = [];
  let views: readonly WorkflowParticipantView[] = [];
  let sentSeq: number | null = null;
  const sentSeqListeners = new Set<() => void>();
  const stateListeners = new Set<() => void>();
  const participantListeners = new Set<() => void>();
  const failureListeners = new Set<() => void>();

  let failures: readonly SendFailure[] = [];
  let failuresKey = '[]';
  const readFailures = (): readonly SendFailure[] => {
    const now = core.sendChecklist(participants) as readonly SendFailure[];
    const key = JSON.stringify(now);
    if (key !== failuresKey) {
      failuresKey = key;
      failures = now;
    }
    return failures;
  };

  const setState = (next: string | null): void => {
    if (next === state) return;
    state = next;
    for (const listener of [...stateListeners]) listener();
  };
  const setParticipants = (next: readonly WorkflowParticipantView[]): void => {
    participants = next;
    for (const listener of [...failureListeners]) listener();
    // The list the banner reads is replaced only when it differs.
    if (JSON.stringify(next) === JSON.stringify(views)) return;
    views = next;
    for (const listener of [...participantListeners]) listener();
  };

  async function refresh(): Promise<void> {
    const current = source();
    if (!current) return;
    try {
      const { value } = await current.port.get(current.docId);
      setParticipants(
        value.participants.map((p) => ({
          id: p.id,
          name: p.name ?? null,
          roles: p.roles,
          state: p.state ?? null,
        })),
      );
      setState(value.state);
      const seq = value.sentSeq ?? null;
      if (seq !== sentSeq) {
        sentSeq = seq;
        for (const listener of [...sentSeqListeners]) listener();
      }
    } catch (error) {
      // A document with no workflow resource yet is a draft with nobody bound.
      if (error instanceof PortError && error.code === 'not_found') {
        setParticipants([]);
        setState('draft');
      }
    }
  }

  // The workflow is read when the editor starts and again whenever the server says it changed
  // (`wf.changed`), so the lock banner and the send dialog follow it without being opened.
  let stop: (() => void) | undefined;
  const first = source();
  if (first) {
    void refresh();
    // The pushed state is applied at once: a participant may not read the resource, and the lock
    // indicator must not wait for a read (FRW-035 criterion 6). The read follows for the list.
    stop = first.port.onChange?.(first.docId, (status) => {
      if (typeof status?.state === 'string') setState(status.state);
      void refresh();
    });
  }

  return {
    dispose() {
      stop?.();
      stop = undefined;
    },
    participants: {
      get: () => views,
      subscribe(listener) {
        participantListeners.add(listener);
        return () => participantListeners.delete(listener);
      },
    },
    sentSeq: {
      get: () => sentSeq,
      subscribe(listener) {
        sentSeqListeners.add(listener);
        return () => sentSeqListeners.delete(listener);
      },
    },
    state: {
      get: () => state,
      subscribe(listener) {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
    },
    failures: {
      get: readFailures,
      subscribe(listener) {
        failureListeners.add(listener);
        const stop = core.revision.subscribe(listener);
        return () => {
          failureListeners.delete(listener);
          stop();
        };
      },
    },
    refresh,
    showField: (key) => core.focusFieldByKey(key),
    showSuggestion: (id) => core.selectSuggestion(id),
    async send() {
      const current = source();
      if (!current) return { ok: false, reason: 'failed' };
      try {
        const { value } = await current.port.act(current.docId, 'send');
        setState(value.state);
        return { ok: true, state: value.state };
      } catch (error) {
        const outcome = refusal(error);
        if (!outcome.ok && outcome.reason === 'not_draft') await refresh();
        return outcome;
      }
    },
  };
}
