/**
 * Signing a signature or initials field (12 §8.1 step 3, §3.3, §4.2 P7 and P8, §10, §14; FRW-046;
 * ADR 0013; docs/adr/0397-w4-FRW-046-sign-commit.md, proposed).
 *
 * `signField` is the service side of `POST /documents/{id}/fields/{fid}/sign`. For a participant
 * who is bound to the request it
 *
 * 1. checks the P7 conditions of the field: the workflow runs and the participant is active, the
 *    field is a `signature` or `initials` field assigned to one of their roles, not read-only, and
 *    visible and enabled under the rules (`checkSignConditions`), and that they accepted the consent
 *    text the service holds now (`consentVerdict`);
 * 2. checks the image they adopted (`adoptSignature`: ready, their own, of this document) and takes
 *    its hash from the stored bytes;
 * 3. writes one server-authored commit with origin `sign` through the outbox: the field's
 *    `{ asset, mode }` and, in the same commit, every `dateSigned` field of the same role set to the
 *    date of the server's clock in the workflow's time zone (`signedDate`), never the client's;
 * 4. records the signing in the participant's evidence with the `seq` and the chain hash of that
 *    commit, and raises `field_completed`.
 *
 * Any refusal happens before step 3, so a refused request writes nothing. A repeat of the same
 * request finds the field already holding the value, writes no second commit and answers with the
 * first (the commit identifier is derived from the field, the participant, the image, the mode and
 * the send, so the outbox holds one item). The hash that the evidence commits to enters the chain
 * with a later control commit, not with this one: the evidence names this commit's `seq` and hash,
 * so it cannot be in it (ADR 0397).
 */
import {
  checkSignConditions,
  DEFAULT_RULE_BUDGET,
  fieldsToDateSign,
  fillActive,
  ruleGate,
  signedDate,
  type ParticipantKind,
} from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';
import { derivedCommitId } from '../data-plane/commit-id.ts';
import type { AssetRegistry } from '../control-plane/assets.ts';
import type { EventSink } from '../control-plane/events.ts';
import type { DocRef, GrantStore, LogStore, OutboxStore } from '../storage/types.ts';
import type { ContentReader } from '../control-plane/content.ts';
import { consentVerdict, type ConsentDeps } from './consent-service.ts';
import { anchorEvidence } from './evidence-anchor.ts';
import type { EvidenceLedger } from './evidence-ledger.ts';
import { raiseWorkflowEvents } from './raise-events.ts';
import { recordOf } from './record.ts';
import { adoptSignature, type AdoptionDeps, type AdoptionProblem } from './signature-adoption.ts';
import type { WorkflowResourceView } from './workflow-resource.ts';

export interface SignDeps {
  readonly workflows: ConsentDeps['workflows'];
  readonly evidence: EvidenceLedger;
  readonly texts: ConsentDeps['texts'];
  readonly assets: Pick<AssetRegistry, 'get'>;
  readonly finals: AdoptionDeps['finals'];
  readonly logs: LogStore;
  readonly content: Pick<ContentReader, 'rebuild'>;
  readonly grants: Pick<GrantStore, 'current'>;
  readonly outbox: OutboxStore;
  readonly events: EventSink;
  readonly now: () => number;
  /** How long the request waits for the room to store the commit, ms. */
  readonly waitMs?: number;
  readonly ruleBudget?: number;
}

export type SignProblem =
  | { readonly code: 'not_found'; readonly what: 'workflow' | 'participant' | 'field' }
  | { readonly code: 'invalid_state'; readonly state: string }
  | { readonly code: 'refused'; readonly reason: string }
  | { readonly code: 'consent'; readonly reason: string }
  | { readonly code: 'adoption'; readonly problem: AdoptionProblem }
  | { readonly code: 'already_signed' }
  | { readonly code: 'not_stored'; readonly reason: string };

export interface Signed {
  readonly seq: number;
  readonly chainHash: string;
  readonly value: { readonly asset: string; readonly mode: string };
  readonly dateSigned: { readonly fields: readonly string[]; readonly date: string } | null;
  /** False when the request repeated one that was already stored. */
  readonly created: boolean;
}

/** What the route knows of the request: the connection's facts, never the client's say. */
export interface SignFacts {
  readonly address: string | null;
  readonly userAgent: string | null;
  readonly amr: readonly string[] | null;
}

type Step = { stepType: 'attr'; pos: number; attr: 'value'; value: unknown };

const sameValue = (a: unknown, b: { asset: string; mode: string }): boolean => {
  if (a === null || typeof a !== 'object') return false;
  const o = a as Record<string, unknown>;
  return o['asset'] === b.asset && o['mode'] === b.mode;
};

/** The hash of the commit at `seq`, from the log; null when the log cannot say. */
async function chainHashAt(deps: SignDeps, ref: DocRef, seq: number): Promise<string | null> {
  const exact = (deps.logs as { chainHeadAt?: (r: DocRef, n: number) => Promise<string | null> })
    .chainHeadAt;
  if (exact) return exact.call(deps.logs, ref, seq);
  const head = await deps.logs.head(ref);
  if (head.seq !== seq) return null;
  return (await deps.logs.state?.(ref))?.chainHead ?? null;
}

export async function signField(
  deps: SignDeps,
  req: {
    ref: DocRef;
    /** The caller's surrogate. */
    actor: string;
    participant: string;
    field: string;
    body: { asset: unknown; mode: unknown };
    facts: SignFacts;
  },
): Promise<{ ok: true; signed: Signed } | { ok: false; problem: SignProblem }> {
  const { ref, actor, participant, field } = req;
  const fail = (problem: SignProblem) => ({ ok: false as const, problem });

  const view = await deps.workflows.read(ref.tenant, ref.doc);
  if (view === null) return fail({ code: 'not_found', what: 'workflow' });
  const who = view.participants.find((p) => p.id === participant);
  if (who === undefined) return fail({ code: 'not_found', what: 'participant' });
  if (view.state !== 'sent' && view.state !== 'in_progress')
    return fail({ code: 'invalid_state', state: view.state });

  // The document whole, as it stands: the fields the participant may not read are still checked.
  const head = await deps.logs.head(ref);
  const full = await deps.content.rebuild(ref, head.incarnation, head.seq);
  const root = cdmSchema().nodeFromJSON(full.doc);
  let found: { pos: number; attrs: Record<string, unknown> } | null = null;
  root.descendants((n, pos) => {
    if (found === null && n.type.name === 'form_field' && n.attrs['id'] === field)
      found = { pos, attrs: n.attrs as Record<string, unknown> };
    return found === null;
  });
  const hit = found as { pos: number; attrs: Record<string, unknown> } | null;
  if (hit === null) return fail({ code: 'not_found', what: 'field' });

  const roles = who.roles;
  const gate = ruleGate(root, roles, deps.ruleBudget ?? DEFAULT_RULE_BUDGET);
  const conditions = checkSignConditions({
    kind: String(hit.attrs['kind']),
    assignee: typeof hit.attrs['assignee'] === 'string' ? hit.attrs['assignee'] : null,
    readOnly: hit.attrs['readOnly'] === true,
    participantRoles: roles,
    active: fillActive(recordOf(view), participant),
    enabled: gate === null ? true : gate.enabled(field, root, String(hit.attrs['key'])),
  });
  if (!conditions.ok) return fail({ code: 'refused', reason: conditions.reason });

  const consent = await consentVerdict(
    { workflows: deps.workflows, evidence: deps.evidence, texts: deps.texts, now: deps.now },
    ref,
    participant,
  );
  if (!consent.ok) return fail({ code: 'consent', reason: consent.reason });

  const adopted = await adoptSignature(deps, {
    tenant: ref.tenant,
    doc: ref.doc,
    actor,
    asset: req.body.asset,
    mode: req.body.mode,
  });
  if (!adopted.ok) return fail({ code: 'adoption', problem: adopted.problem });
  const { value, imageHash } = adopted.adoption;

  const current = hit.attrs['value'] ?? null;
  const repeat = current !== null;
  if (repeat && !sameValue(current, value)) return fail({ code: 'already_signed' });

  const assignee = String(hit.attrs['assignee']);
  const at = deps.now();
  const date = signedDate(at, view.timeZone);
  const dateFields = fieldsToDateSign(root, assignee);
  const steps: Step[] = [{ stepType: 'attr', pos: hit.pos, attr: 'value', value }];
  root.descendants((n, pos) => {
    if (n.type.name === 'form_field' && dateFields.includes(String(n.attrs['id'])))
      steps.push({ stepType: 'attr', pos, attr: 'value', value: date });
    return true;
  });

  const perms = await deps.grants.current(ref);
  const item = await deps.outbox.enqueue({
    tenant: ref.tenant,
    doc: ref.doc,
    // The same request is the same commit: the field, the person, the image, the mode and the send
    // name it, so a repeat stores one item and one commit (ADR 0397).
    commitId: derivedCommitId(
      'sign',
      ref.tenant,
      ref.doc,
      field,
      participant,
      value.asset,
      value.mode,
      String(view.sentSeq ?? 0),
    ),
    kind: 'author',
    request: {
      origin: 'sign',
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
  const chainHash = await chainHashAt(deps, ref, seq);
  if (chainHash === null)
    return fail({ code: 'not_stored', reason: 'the log cannot name the chain hash of the commit' });

  // The evidence of this signing, once: a repeat records it only when the first attempt stopped
  // before it did.
  const recorded = (await deps.evidence.list(ref.tenant, ref.doc)).find(
    (r) =>
      r.participant === participant &&
      r.item === 'signed' &&
      (
        (r.evidence.items as Record<string, unknown>)['signings'] as
          Array<{ seq?: number }> | undefined
      )?.some((s) => s.seq === seq) === true,
  );
  let evidenceHash = recorded?.hash ?? null;
  if (recorded === undefined) {
    const made = await deps.evidence.record(ref.tenant, {
      doc: ref.doc,
      participant,
      kind: who.kind as ParticipantKind,
      item: 'signed',
      origin: 'sign',
      facts: {
        items: {
          signings: [
            {
              seq,
              chainHash,
              fieldKey: String(hit.attrs['key']),
              atMs: at,
              mode: value.mode,
              imageHash,
            },
          ],
          ...(req.facts.amr !== null ? { amr: [...req.facts.amr] } : {}),
        },
        ipAddress: req.facts.address,
        userAgent: req.facts.userAgent,
      },
    });
    evidenceHash = made.hash;
    await raiseWorkflowEvents(
      deps,
      ref,
      view as WorkflowResourceView,
      { seq, chainHead: chainHash },
      [{ name: 'field_completed', participant }],
    );
  }
  // The salted hash of the evidence enters the chain in a control commit after the signing (12 §7;
  // FRW-041). A repeat anchors the same hash under the same commit identifier, so it is one commit.
  if (evidenceHash !== null) await anchorEvidence(deps, ref, { origin: 'sign', evidenceHash });
  return {
    ok: true,
    signed: {
      seq,
      chainHash,
      value,
      dateSigned: dateFields.length === 0 ? null : { fields: dateFields, date },
      created: !repeat,
    },
  };
}
