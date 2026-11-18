/**
 * A participant completes their part (12 §5.3, §6.2, §8.1 step 4; FRW-047;
 * docs/adr/0398-w4-FRW-047-complete-participant.md, proposed).
 *
 * `completeMyPart` is the service side of `POST /documents/{id}/workflow/participants/{pid}/complete`.
 * For a participant who is bound to the request it
 *
 * 1. checks that the workflow is `in_progress` and the participant is active (not completed, not a
 *    `cc`, past their access code); a participant who has completed already gets the first answer
 *    again and nothing is written;
 * 2. checks the required fields and the validations of the fields assigned to their roles that are
 *    visible and enabled (`completionCheck`); a failure refuses the completion and lists each field
 *    key and the rule or validation, and the participant stays active. An approver owns no fields,
 *    so there is nothing to check;
 * 3. writes one server-authored commit with origin `rules`: the formula results, and null for every
 *    hidden field that holds a value (`hiddenValuesToClear`). The commit identifier names the
 *    participant, the send, the head and the steps, so a repeat of the same request is one outbox
 *    item and one commit. When nothing needs writing, no commit is made;
 * 4. marks the participant completed with `completedSeq`, moves the workflow on (`recordCompletion`:
 *    the next order, or `completed`) and records the evidence of the completion.
 *
 * Every refusal comes before step 3, so a refused request writes nothing. A process that stops
 * between steps 3 and 4 leaves the `rules` commit stored; the repeat finds nothing left to write and
 * goes on to step 4, so the commit is applied once. The events are returned for the route to raise.
 */
import {
  completionCheck,
  DEFAULT_RULE_BUDGET,
  completionWrites,
  fillActive,
  type CompletionProblem,
  type ParticipantKind,
} from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';
import { derivedCommitId, stableJson } from '../data-plane/commit-id.ts';
import type { ContentReader } from '../control-plane/content.ts';
import type { DocRef, OutboxStore } from '../storage/types.ts';
import type { EvidenceLedger } from './evidence-ledger.ts';
import { recordCompletion, type ProgressOutcome } from './progress.ts';
import { recordOf } from './record.ts';
import type { TransitionDeps } from './transitions.ts';

export interface CompleteDeps extends TransitionDeps {
  readonly evidence: EvidenceLedger;
  readonly content: Pick<ContentReader, 'rebuild'>;
  readonly outbox: OutboxStore;
  /** How long the request waits for the room to store the `rules` commit, ms. */
  readonly waitMs?: number;
  readonly ruleBudget?: number;
}

export type CompleteProblem =
  | { readonly code: 'not_found'; readonly what: 'workflow' | 'participant' }
  | { readonly code: 'invalid_state'; readonly state: string }
  | { readonly code: 'forbidden'; readonly reason: string }
  | { readonly code: 'validation'; readonly problems: readonly CompletionProblem[] }
  | { readonly code: 'conflict'; readonly state: string }
  | { readonly code: 'not_stored'; readonly reason: string };

export type CompleteOutcome =
  | {
      readonly ok: true;
      /** False when the participant had completed already and nothing was written. */
      readonly changed: boolean;
      readonly resource: Extract<ProgressOutcome, { ok: true }>['resource'];
      readonly control: Extract<ProgressOutcome, { ok: true }>['control'];
      readonly raised: Extract<ProgressOutcome, { ok: true }>['raised'];
      readonly completedSeq: number;
      /** The `seq` of the `rules` commit, or null when nothing needed writing. */
      readonly rulesSeq: number | null;
    }
  | { readonly ok: false; readonly problem: CompleteProblem };

/** What the route knows of the request: the connection's facts, never the client's say. */
export interface CompleteFacts {
  readonly address: string | null;
  readonly userAgent: string | null;
}

type Step = { stepType: 'attr'; pos: number; attr: 'value'; value: unknown };

export async function completeMyPart(
  deps: CompleteDeps,
  req: { ref: DocRef; actor: string; participant: string; facts: CompleteFacts },
): Promise<CompleteOutcome> {
  const { ref, actor, participant } = req;
  const fail = (problem: CompleteProblem) => ({ ok: false as const, problem });

  const view = await deps.workflows.read(ref.tenant, ref.doc);
  if (view === null) return fail({ code: 'not_found', what: 'workflow' });
  const who = view.participants.find((p) => p.id === participant);
  if (who === undefined) return fail({ code: 'not_found', what: 'participant' });

  // A second call changes nothing: the participant's mark and `completedSeq` stand (criterion 6).
  if (who.state === 'completed')
    return {
      ok: true,
      changed: false,
      resource: view,
      control: null,
      raised: [],
      completedSeq: who.completedSeq ?? 0,
      rulesSeq: null,
    };

  if (view.state !== 'in_progress') return fail({ code: 'invalid_state', state: view.state });
  if (!fillActive(recordOf(view), participant))
    return fail({ code: 'forbidden', reason: 'the participant is not active in the workflow' });

  // The document whole, as it stands (ADR 0019: a check over a projection would miss fields).
  const head = await deps.logs.head(ref);
  const full = await deps.content.rebuild(ref, head.incarnation, head.seq);
  const root = cdmSchema().nodeFromJSON(full.doc);
  const budget = deps.ruleBudget ?? DEFAULT_RULE_BUDGET;
  const now = { instant: new Date(deps.now()).toISOString(), timeZone: view.timeZone };

  if (who.kind !== 'approver') {
    const verdict = completionCheck(root, who.roles, now, budget);
    if (!verdict.ok) return fail({ code: 'validation', problems: verdict.problems });
  }

  // The `rules` commit: formula results and the hidden values cleared.
  const steps: Step[] = [];
  const written = completionWrites(root, who.roles, now, budget);
  if (!written.ok)
    return fail({
      code: 'validation',
      problems: [
        {
          key: '',
          id: null,
          code: 'rules_unavailable',
          message: 'the rules could not be evaluated, so completion is refused',
        },
      ],
    });
  const target = new Map(written.writes.map((w) => [w.key, w.value]));
  root.descendants((n, pos) => {
    if (n.type.name === 'form_field' && target.has(String(n.attrs['key'])))
      steps.push({
        stepType: 'attr',
        pos,
        attr: 'value',
        value: target.get(String(n.attrs['key'])),
      });
    return true;
  });

  let rulesSeq: number | null = null;
  if (steps.length > 0) {
    const perms = await deps.grants.current(ref);
    const item = await deps.outbox.enqueue({
      tenant: ref.tenant,
      doc: ref.doc,
      commitId: derivedCommitId(
        'rules',
        ref.tenant,
        ref.doc,
        participant,
        String(view.sentSeq ?? 0),
        String(head.seq),
        stableJson(steps),
      ),
      kind: 'author',
      request: {
        origin: 'rules',
        actor,
        base: head.seq,
        steps,
        preconditions: {
          revision: perms.revision,
          documentState: perms.documentState,
          workflowActive: perms.workflowActive,
        },
      },
    });
    const deadline = deps.now() + (deps.waitMs ?? 10_000);
    let settled = item;
    while (settled.state === 'pending' && deps.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = (await deps.outbox.get(ref.tenant, item.id)) ?? settled;
    }
    if (settled.state === 'failed') {
      const r = settled.result as { code?: string; message?: string } | null;
      return fail({
        code: 'not_stored',
        reason: `${r?.code ?? 'refused'}${r?.message ? `: ${r.message}` : ''}`,
      });
    }
    const seq = (settled.result as { seq?: unknown } | null)?.seq;
    if (settled.state !== 'done' || typeof seq !== 'number')
      return fail({ code: 'not_stored', reason: 'the room has not stored the commit yet' });
    rulesSeq = seq;
  }

  // Nothing to write: the participant completes at the head the checks read.
  const completedSeq = rulesSeq ?? head.seq;
  // FRW-037: the routes see the document as the completion leaves it, formula results included.
  const routingDocument =
    view.members.routing === undefined
      ? undefined
      : rulesSeq === null
        ? { cdm: full.cdm, requires: full.requires, doc: full.doc }
        : await deps.content
            .rebuild(ref, head.incarnation, rulesSeq)
            .then((after) => ({ cdm: after.cdm, requires: after.requires, doc: after.doc }));
  const out = await recordCompletion(deps, {
    ref,
    actor,
    participant,
    completedSeq,
    ...(routingDocument !== undefined ? { routingDocument } : {}),
  });
  if (!out.ok) {
    if (out.problem.code === 'not_found') return fail({ code: 'not_found', what: 'workflow' });
    if (out.problem.code === 'forbidden')
      return fail({ code: 'forbidden', reason: 'the participant is not active in the workflow' });
    return fail({ code: 'conflict', state: out.problem.state });
  }

  // The evidence of the completion.
  await deps.evidence.record(ref.tenant, {
    doc: ref.doc,
    participant,
    kind: who.kind as ParticipantKind,
    item: 'completed',
    origin: 'rules',
    facts: {
      items: { completedAtMs: deps.now() },
      ipAddress: req.facts.address,
      userAgent: req.facts.userAgent,
    },
  });
  return {
    ok: true,
    changed: true,
    resource: out.resource,
    control: out.control,
    raised: out.raised,
    completedSeq,
    rulesSeq,
  };
}
