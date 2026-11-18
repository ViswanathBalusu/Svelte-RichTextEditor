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
 * Not built: the push `wf.changed` (FRW-035 on the client), so a change made by another person
 * shows when the dialog is opened again.
 */
import { PortError, type WorkflowPort } from '@docedit/protocol';
import type { EditorCore } from '@docedit/engine';
import type { WorkflowSendOutcome, WorkflowSendService } from '@docedit/ui';
import { failuresFromViolations, type SendFailure } from '@docedit/ui/send-checklist';

/** What the service needs of the session: the port and the document it is for. */
export interface WorkflowSendSource {
  readonly port: Pick<WorkflowPort, 'get' | 'act'>;
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
  const stateListeners = new Set<() => void>();
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
  const setParticipants = (next: readonly { readonly roles: readonly string[] }[]): void => {
    participants = next;
    for (const listener of [...failureListeners]) listener();
  };

  async function refresh(): Promise<void> {
    const current = source();
    if (!current) return;
    try {
      const { value } = await current.port.get(current.docId);
      setParticipants(value.participants.map((p) => ({ roles: p.roles })));
      setState(value.state);
    } catch (error) {
      // A document with no workflow resource yet is a draft with nobody bound.
      if (error instanceof PortError && error.code === 'not_found') {
        setParticipants([]);
        setState('draft');
      }
    }
  }

  return {
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
