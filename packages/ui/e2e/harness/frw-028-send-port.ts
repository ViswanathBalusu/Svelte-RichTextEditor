/**
 * A send-for-completion service for the shell's browser tests of the send dialog (FRW-028). It
 * answers from a fixed checklist and records what the shell asked of it on the returned `log`:
 * the fields and suggestions the dialog moved to, how often the resource was read and how often a
 * send was asked for.
 *
 * Modes: `pass` (every check passes; a send succeeds), `fail` (every check fails), `server-refuses`
 * (the editor's checks pass; the server refuses a send and names a role), `forbidden` (the editor's
 * checks pass; the server refuses a send), `sent` (the workflow is already sent) and `unread`
 * (the resource never arrives, so the state stays unknown). `running`, `declined` and `voided` are
 * workflows past the send, with Ada Lovelace to act now and a participant with no name waiting
 * (FRW-029 criterion 6: the lock banner).
 */
import type {
  ReadView,
  WorkflowParticipantView,
  WorkflowSendOutcome,
  WorkflowSendService,
} from '../../src/core-api.ts';
import type { SendFailure } from '../../src/shell/send-checklist.ts';

export type SendHarnessMode =
  | 'pass'
  | 'fail'
  | 'server-refuses'
  | 'forbidden'
  | 'sent'
  | 'unread'
  | 'running'
  | 'declined'
  | 'voided';

export interface SendHarnessLog {
  fields: string[];
  suggestions: string[];
  refreshes: number;
  sends: number;
}

export const ALL_FAIL: readonly SendFailure[] = [
  { code: 'required_field_unassigned', keys: ['tenant.email', 'tenant.phone'] },
  { code: 'role_without_participant', roles: ['role_landlord'] },
  { code: 'rules_invalid', problems: [{ path: '/rules/r1' }] },
  { code: 'pending_suggestions', suggestionIds: ['sPropose00000001'] },
];

function view<T>(initial: T): ReadView<T> & { set(next: T): void } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const PEOPLE: readonly WorkflowParticipantView[] = [
  { id: 'p1', name: 'Ada Lovelace', roles: ['role_tenant'], state: 'active' },
  { id: 'p2', name: null, roles: ['role_landlord'], state: 'pending' },
];

const STATE_OF: Readonly<Partial<Record<SendHarnessMode, string>>> = {
  sent: 'sent',
  running: 'in_progress',
  declined: 'declined',
  voided: 'voided',
};

export function sendService(
  mode: SendHarnessMode,
  log: SendHarnessLog,
): WorkflowSendService & {
  setFailures(next: readonly SendFailure[]): void;
  setState(next: string | null): void;
} {
  const failures = view<readonly SendFailure[]>(mode === 'fail' ? ALL_FAIL : []);
  const state = view<string | null>(mode === 'unread' ? null : (STATE_OF[mode] ?? 'draft'));
  const participants = view<readonly WorkflowParticipantView[]>(
    STATE_OF[mode] !== undefined && mode !== 'sent' ? PEOPLE : [],
  );
  return {
    state,
    failures,
    participants,
    setFailures: (next) => failures.set(next),
    setState: (next) => state.set(next),
    async refresh() {
      log.refreshes++;
    },
    showField(key) {
      log.fields.push(key);
      return true;
    },
    showSuggestion(id) {
      log.suggestions.push(id);
      return true;
    },
    async send(): Promise<WorkflowSendOutcome> {
      log.sends++;
      if (mode === 'forbidden') return { ok: false, reason: 'forbidden' };
      if (mode === 'server-refuses')
        return {
          ok: false,
          reason: 'checklist_failed',
          failures: [{ code: 'role_without_participant', roles: ['role_landlord'] }],
        };
      state.set('sent');
      return { ok: true, state: 'sent' };
    },
  };
}
