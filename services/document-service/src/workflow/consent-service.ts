/**
 * The consent step of the signing ceremony on the service side (12 §6.1 `consent`, §7, §8.1 step 1;
 * FRW-044; docs/adr/0395-w4-FRW-044-consent-text-store.md, proposed).
 *
 * - `acceptConsent` records one participant's acceptance of the text the workflow's `consent` names
 *   (`textId` and `version`). The service reads the text from its own store, hashes it
 *   (`recordConsent` of the authority takes no hash from anyone), and stores the acceptance as the
 *   `consent` item of the participant's evidence (FRW-040), timed by the service clock. A repeat of
 *   the same acceptance changes nothing and returns the one on record.
 * - `consentVerdict` is the check a sign request makes (FRW-046): the participant has an acceptance
 *   on record for the text and version the workflow names now, and the text the service holds still
 *   has the hash that was recorded (`checkConsentForSign`). A changed text refuses an earlier
 *   acceptance (ADR 0148, item 1, accepted with decision 184).
 *
 * Only a `filler` or a `signer` accepts a consent text (ADR 0250, item 1); an `approver` or a `cc`
 * has none. A participant whose access code is not yet verified cannot accept. The text store is a
 * port: where texts are authored and localised is not specified (FRW-044 Notes), so the route is
 * offered only when a store is composed.
 */
import {
  checkConsentForSign,
  recordConsent,
  type ConsentRecord,
  type ConsentVerdict,
  type ParticipantKind,
} from '@docedit/authority';
import type { DocRef } from '../storage/types.ts';
import type { EvidenceLedger } from './evidence-ledger.ts';
import type { WorkflowResourceStore, WorkflowResourceView } from './workflow-resource.ts';

/** The consent texts of a tenant, by identifier and version. */
export interface ConsentTextStore {
  /** The text, or null when the tenant holds none under that identifier and version. */
  get(tenant: string, textId: string, version: number): Promise<string | null>;
}

/** The in-memory store (tests and the memory build). */
export class MemoryConsentTextStore implements ConsentTextStore {
  readonly #texts = new Map<string, string>();

  put(tenant: string, textId: string, version: number, text: string): void {
    this.#texts.set(`${tenant}\u0000${textId}\u0000${version}`, text);
  }

  get(tenant: string, textId: string, version: number): Promise<string | null> {
    return Promise.resolve(this.#texts.get(`${tenant}\u0000${textId}\u0000${version}`) ?? null);
  }
}

export interface ConsentDeps {
  readonly workflows: Pick<WorkflowResourceStore, 'read'>;
  readonly evidence: EvidenceLedger;
  readonly texts: ConsentTextStore;
  readonly now: () => number;
}

/** What the route knows of the request: the connection's facts, never the client's say. */
export interface ConsentFacts {
  readonly address: string | null;
  readonly userAgent: string | null;
  readonly amr: readonly string[] | null;
}

export type ConsentProblem =
  | { readonly code: 'not_found' }
  | { readonly code: 'invalid_state'; readonly state: string }
  | { readonly code: 'no_consent' }
  | { readonly code: 'not_applicable'; readonly kind: string }
  | { readonly code: 'awaiting_code' }
  | { readonly code: 'text_missing' };

export interface ConsentAccepted {
  readonly textId: string;
  readonly version: number;
  readonly hash: string;
  readonly atMs: number;
}

type Who = WorkflowResourceView['participants'][number];

const CONSENT_KINDS: readonly string[] = ['filler', 'signer'];

/** The newest acceptance the participant has on record, or undefined. */
async function recordOnFile(
  evidence: EvidenceLedger,
  tenant: string,
  doc: string,
  participant: string,
): Promise<ConsentRecord | undefined> {
  const rows = await evidence.list(tenant, doc);
  let found: ConsentRecord | undefined;
  for (const row of rows) {
    if (row.participant !== participant || row.item !== 'consent') continue;
    const c = (row.evidence.items as Record<string, unknown>)['consent'] as
      { textId: string; version: number; hash: string; atMs: number } | undefined;
    if (c === undefined) continue;
    found = {
      textId: c.textId,
      version: String(c.version),
      participantId: participant,
      acceptedAtMs: c.atMs,
      textHash: c.hash,
    };
  }
  return found;
}

type Loaded =
  | {
      ok: true;
      view: WorkflowResourceView;
      who: Who;
      consent: { textId: string; version: number };
    }
  | { ok: false; problem: ConsentProblem };

async function load(
  deps: Pick<ConsentDeps, 'workflows'>,
  ref: DocRef,
  participant: string,
): Promise<Loaded> {
  const view = await deps.workflows.read(ref.tenant, ref.doc);
  if (view === null) return { ok: false, problem: { code: 'not_found' } };
  const who = view.participants.find((p) => p.id === participant);
  if (who === undefined) return { ok: false, problem: { code: 'not_found' } };
  const c = view.members.consent;
  if (c?.textId === undefined || c.version === undefined)
    return { ok: false, problem: { code: 'no_consent' } };
  return { ok: true, view, who, consent: { textId: c.textId, version: c.version } };
}

export async function acceptConsent(
  deps: ConsentDeps,
  req: { ref: DocRef; participant: string; facts: ConsentFacts },
): Promise<{ ok: true; accepted: ConsentAccepted } | { ok: false; problem: ConsentProblem }> {
  const { ref, participant, facts } = req;
  const got = await load(deps, ref, participant);
  if (!got.ok) return got;
  const { view, who, consent } = got;
  if (!CONSENT_KINDS.includes(who.kind))
    return { ok: false, problem: { code: 'not_applicable', kind: who.kind } };
  if (view.state !== 'sent' && view.state !== 'in_progress')
    return { ok: false, problem: { code: 'invalid_state', state: view.state } };
  if (who.auth?.require?.includes('access_code') === true && who.verifiedAt === undefined)
    return { ok: false, problem: { code: 'awaiting_code' } };
  const text = await deps.texts.get(ref.tenant, consent.textId, consent.version);
  if (text === null) return { ok: false, problem: { code: 'text_missing' } };

  const made = await recordConsent(
    { textId: consent.textId, version: String(consent.version), text },
    participant,
    deps.now(),
  );
  // The same text accepted again changes nothing: the acceptance on record stands.
  const before = await recordOnFile(deps.evidence, ref.tenant, ref.doc, participant);
  if (
    before !== undefined &&
    before.textId === made.textId &&
    before.version === made.version &&
    before.textHash === made.textHash
  )
    return {
      ok: true,
      accepted: {
        textId: before.textId,
        version: consent.version,
        hash: before.textHash,
        atMs: before.acceptedAtMs,
      },
    };
  const fact: ConsentAccepted = {
    textId: made.textId,
    version: consent.version,
    hash: made.textHash,
    atMs: made.acceptedAtMs,
  };
  await deps.evidence.record(ref.tenant, {
    doc: ref.doc,
    participant,
    kind: who.kind as ParticipantKind,
    item: 'consent',
    facts: {
      items: {
        consent: fact,
        ...(facts.amr !== null ? { amr: [...facts.amr] } : {}),
      },
      ipAddress: facts.address,
      userAgent: facts.userAgent,
    },
  });
  return { ok: true, accepted: fact };
}

/** What a participant reads before accepting: the text the workflow names, and their acceptance of it. */
export interface ConsentView {
  readonly textId: string;
  readonly version: number;
  readonly text: string;
  /** The time of the acceptance on record for this very text, or null (none, or the text has changed). */
  readonly acceptedAtMs: number | null;
}

/**
 * The consent text the workflow names, for the participant who has to accept it (FRW-044 criterion
 * 1). The same preconditions as `acceptConsent` hold, so a participant who cannot accept is not
 * shown a text. An earlier acceptance of a text that has since changed does not count: the view
 * says it is not accepted.
 */
export async function readConsent(
  deps: ConsentDeps,
  ref: DocRef,
  participant: string,
): Promise<{ ok: true; view: ConsentView } | { ok: false; problem: ConsentProblem }> {
  const got = await load(deps, ref, participant);
  if (!got.ok) return got;
  const { view, who, consent } = got;
  if (!CONSENT_KINDS.includes(who.kind))
    return { ok: false, problem: { code: 'not_applicable', kind: who.kind } };
  if (view.state !== 'sent' && view.state !== 'in_progress')
    return { ok: false, problem: { code: 'invalid_state', state: view.state } };
  if (who.auth?.require?.includes('access_code') === true && who.verifiedAt === undefined)
    return { ok: false, problem: { code: 'awaiting_code' } };
  const text = await deps.texts.get(ref.tenant, consent.textId, consent.version);
  if (text === null) return { ok: false, problem: { code: 'text_missing' } };
  const verdict = await consentVerdict(deps, ref, participant);
  const record = verdict.ok
    ? await recordOnFile(deps.evidence, ref.tenant, ref.doc, participant)
    : undefined;
  return {
    ok: true,
    view: {
      textId: consent.textId,
      version: consent.version,
      text,
      acceptedAtMs: record?.acceptedAtMs ?? null,
    },
  };
}

/**
 * Whether a sign request of `participant` may proceed on the consent: the acceptance on record,
 * checked against the text the service holds now for the workflow's `consent`.
 */
export async function consentVerdict(
  deps: ConsentDeps,
  ref: DocRef,
  participant: string,
): Promise<ConsentVerdict> {
  const got = await load(deps, ref, participant);
  if (!got.ok)
    return {
      ok: false,
      reason:
        got.problem.code === 'no_consent'
          ? 'the workflow names no consent text'
          : 'the participant is not in the workflow',
    };
  const text = await deps.texts.get(ref.tenant, got.consent.textId, got.consent.version);
  if (text === null) return { ok: false, reason: 'the consent text is not held' };
  return checkConsentForSign(
    await recordOnFile(deps.evidence, ref.tenant, ref.doc, participant),
    participant,
    { textId: got.consent.textId, version: String(got.consent.version), text },
  );
}
