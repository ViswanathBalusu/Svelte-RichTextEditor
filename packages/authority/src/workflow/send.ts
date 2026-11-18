/**
 * Sending a document for completion (12 §6.2 `send`; FRW-027). Pure functions: the checklist over the
 * document and the participants, and the transition from `draft` to `sent`.
 *
 * The checklist has four checks, each reported as one problem that lists every failure of its kind:
 * - `required_field_unassigned`: a `required` field has no assignee (`assignee` null or absent);
 * - `role_without_participant`: a `role_def` has no participant who holds it;
 * - `rules_invalid`: the rule set does not compile (`compileDocument` of `@docedit/rules`);
 * - `pending_suggestions`: a tracked change (`ins`, `del` or `fmt` mark) is unresolved; the code is the
 *   registry's `pending_suggestions`.
 *
 * Not built here: the idempotency key (repeating a send), the lock of the document (FRW-029), the
 * `sent` version and its commit, the webhooks and the `wf.changed` push, and the `sentHash` check that
 * the hash is the chain hash at `sentSeq` (the service supplies it).
 */
import { compileDocument, type RuleProblem } from '@docedit/rules';
import type { Caller, WorkflowParticipant, WorkflowRecord } from './lifecycle.ts';

/** The marks that are suggestions (tracked changes), as in `packages/model` (`ins`, `del`, `fmt`). */
const SUGGESTION_MARKS: ReadonlySet<string> = new Set(['ins', 'del', 'fmt']);

export type SendProblem =
  | { readonly code: 'required_field_unassigned'; readonly keys: readonly string[] }
  | { readonly code: 'role_without_participant'; readonly roles: readonly string[] }
  | { readonly code: 'rules_invalid'; readonly problems: readonly RuleProblem[] }
  | { readonly code: 'pending_suggestions'; readonly suggestionIds: readonly (string | null)[] };

export type SendResult =
  | { readonly ok: true; readonly record: WorkflowRecord }
  | {
      readonly ok: false;
      readonly refusal: 'forbidden' | 'invalid_state' | 'checklist_failed';
      /** The failures of the checklist; empty unless `refusal` is `checklist_failed`. */
      readonly problems: readonly SendProblem[];
    };

/** The head of the log at the send: the `seq` of the commit and its chain hash. */
export interface SentHead {
  readonly seq: number;
  readonly hash: string;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Scan {
  unassigned: string[];
  roles: string[];
  suggestions: (string | null)[];
}

function scan(node: unknown, out: Scan): void {
  if (!isObj(node)) return;
  const attrs = isObj(node['attrs']) ? node['attrs'] : undefined;
  if (node['type'] === 'form_field' && attrs !== undefined) {
    const key = attrs['key'];
    const assigned = typeof attrs['assignee'] === 'string' && attrs['assignee'] !== '';
    if (typeof key === 'string' && attrs['required'] === true && !assigned)
      out.unassigned.push(key);
  }
  if (node['type'] === 'role_def' && attrs !== undefined && typeof attrs['id'] === 'string')
    out.roles.push(attrs['id']);
  if (Array.isArray(node['marks']))
    for (const mark of node['marks']) {
      if (!isObj(mark) || typeof mark['type'] !== 'string' || !SUGGESTION_MARKS.has(mark['type']))
        continue;
      const id = isObj(mark['attrs']) ? mark['attrs']['id'] : undefined;
      out.suggestions.push(typeof id === 'string' ? id : null);
    }
  if (Array.isArray(node['content'])) for (const child of node['content']) scan(child, out);
}

/**
 * The checklist of FRW-027 criterion 1 over a document in its JSON form (an envelope or the `doc`
 * node). An empty list means every check passed.
 */
export function sendChecklist(
  input: unknown,
  participants: readonly WorkflowParticipant[],
  routedRoles: readonly string[] = [],
): SendProblem[] {
  const root = isObj(input) && 'doc' in input ? input['doc'] : input;
  const found: Scan = { unassigned: [], roles: [], suggestions: [] };
  scan(root, found);

  const problems: SendProblem[] = [];
  const unassigned = [...new Set(found.unassigned)];
  if (unassigned.length > 0) problems.push({ code: 'required_field_unassigned', keys: unassigned });

  // A role that a routing rule may add needs no holder yet (FRW-037; docs/adr/0405-w4-FRW-037-routing.md).
  const held = new Set([...participants.flatMap((p) => p.roles), ...routedRoles]);
  const roles = [...new Set(found.roles)].filter((r) => !held.has(r));
  if (roles.length > 0) problems.push({ code: 'role_without_participant', roles });

  const rules = compileDocument(input);
  if (!rules.ok) problems.push({ code: 'rules_invalid', problems: rules.problems });

  if (found.suggestions.length > 0)
    problems.push({
      code: 'pending_suggestions',
      suggestionIds: [...new Set(found.suggestions)],
    });
  return problems;
}

/**
 * The transition from `draft` to `sent` (FRW-027 criteria 1, 2 and 6, and the state part of
 * criterion 3). A caller without `manage` is refused as `forbidden`; a workflow that is not `draft` is
 * refused as `invalid_state`; a failed checklist is refused with every failure and the record is not
 * changed (the caller keeps the draft). On success the record is `sent` with `sentSeq` and `sentHash`;
 * the lowest-order participants are active (see `order.ts`).
 */
export function sendWorkflow(
  record: WorkflowRecord,
  caller: Caller,
  input: unknown,
  head: SentHead,
  routedRoles: readonly string[] = [],
): SendResult {
  if (!caller.manage) return { ok: false, refusal: 'forbidden', problems: [] };
  if (record.state !== 'draft') return { ok: false, refusal: 'invalid_state', problems: [] };
  const problems = sendChecklist(input, record.participants, routedRoles);
  if (problems.length > 0) return { ok: false, refusal: 'checklist_failed', problems };
  return {
    ok: true,
    record: { ...record, state: 'sent', sentSeq: head.seq, sentHash: head.hash },
  };
}
