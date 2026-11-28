/**
 * Send for completion in the reference host (UX-099; 12 §6, §7, §8; 13 §11.2). The host, and not
 * the document service, binds people to the roles of a document, invites them by e-mail, proves
 * who they are and mints their tokens (12 §6.3). This file holds that work:
 *
 * - `sendForCompletion`: the owner names a person for each role placeholder (name, address, order);
 *   the host writes the workflow resource with those participants and calls `send` with its service
 *   credential, naming the owner in `DEP-Actor`.
 * - `handleWorkflowEvent`: `participant_activated` sends the invitation, `reminder_due` a reminder,
 *   `completed` and `finalised` fetch the sealed PDF and the evidence bundle for the owner.
 * - `startPasscode` and `verifyPasscode`: the link in a mail carries an invitation reference and no
 *   token. Following it, the person asks for a one-time passcode, which the host mails to the
 *   address it holds, and enters it. Then, and only then, the host mints a `filler` token with
 *   `wfp`, `amr` and `auth_time` as it asserted them.
 *
 * Addresses and the people behind the participants stay in the host's own store (`workflows.json`
 * in its data directory), never in the service: the participant's `sub` is an opaque identifier
 * made here. Demo only: a real host keeps these in its own database and sends mail through its own
 * mail service.
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Catalogue } from './catalogue.ts';
import type { HostConfig } from './config.ts';
import { isSendableAddress } from './smtp.ts';
import type { ServiceClient, WorkflowView } from './service.ts';
import type { TokenIssuer } from './tokens.ts';
import type { ReceivedEvent } from './webhook-receiver.ts';

/** What the host needs of itself for this work. */
export interface WorkflowHost {
  service: ServiceClient;
  tokens: TokenIssuer;
  catalogue: Catalogue;
  config: Pick<HostConfig, 'dataDir'>;
  /** The clock; tests set it. */
  now?: () => Date;
}

/** Sends one e-mail. In the demo stack this is the development mail sink. */
export type Mailer = (message: {
  to: string;
  subject: string;
  text: string;
  /** Stable for one event and person, so that a replay is recognisable. */
  messageId: string;
}) => Promise<void>;

export const PARTICIPANT_KINDS = ['filler', 'signer', 'approver', 'cc'] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];

/** The statement the demo makes about its signatures (12 §8.3). Shown on every participant page. */
export const SIGNATURE_STATEMENT =
  'Signatures made here are simple electronic signatures. Each one comes with evidence of who made it and when, and the finished document carries a tamper-evident seal.';

export interface ParticipantBinding {
  id: string;
  /** Opaque, made by the host; the `sub` of the participant's tokens. */
  sub: string;
  name: string;
  email: string;
  roles: string[];
  kind: ParticipantKind;
  order: number;
  /** The SHA-256 of the invitation reference in the newest mail; the reference itself is not kept. */
  invitation?: string;
  /** A passcode asked for through the invitation: its hash, when it lapses, how often it was tried. */
  passcode?: { hash: string; expiresAt: number; attempts: number };
  /** How the participant's part ended, as the service reported it (UX-106); the host then mints no more tokens. */
  finished?: 'completed' | 'declined';
}

export interface WorkflowRecord {
  doc: string;
  workflow: string;
  owner: string;
  sentAt: string;
  participants: ParticipantBinding[];
  state: 'sent' | 'completed' | 'finalised' | 'declined';
  /** Files fetched for the owner, named in the host's data directory. */
  results?: { sealedPdf?: string; evidence?: string; fetchedAt: string };
}

export class WorkflowStore {
  readonly #path: string;
  readonly #records: Map<string, WorkflowRecord>;

  private constructor(path: string, records: Map<string, WorkflowRecord>) {
    this.#path = path;
    this.#records = records;
  }

  static async open(dataDir: string): Promise<WorkflowStore> {
    const path = join(dataDir, 'workflows.json');
    let records: WorkflowRecord[] = [];
    try {
      records = (JSON.parse(await readFile(path, 'utf8')) as { workflows: WorkflowRecord[] })
        .workflows;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return new WorkflowStore(path, new Map(records.map((r) => [r.doc, r])));
  }

  get(doc: string): WorkflowRecord | null {
    return this.#records.get(doc) ?? null;
  }

  /** The record and participant whose newest invitation has this reference. */
  byInvitation(
    reference: string,
  ): { record: WorkflowRecord; participant: ParticipantBinding } | null {
    const hash = sha256(reference);
    for (const record of this.#records.values())
      for (const participant of record.participants)
        if (participant.invitation === hash) return { record, participant };
    return null;
  }

  async put(record: WorkflowRecord): Promise<void> {
    this.#records.set(record.doc, record);
    await this.save();
  }

  /** Forgets a record, for a send that the service refused. */
  async remove(doc: string): Promise<void> {
    if (this.#records.delete(doc)) await this.save();
  }

  /** Writes after a change made in place to a record that `get` returned. */
  async save(): Promise<void> {
    await mkdir(join(this.#path, '..'), { recursive: true });
    const temp = `${this.#path}.${process.pid}.tmp`;
    await writeFile(
      temp,
      `${JSON.stringify({ workflows: [...this.#records.values()] }, null, 2)}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
    await rename(temp, this.#path);
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** A version 7 UUID (RFC 9562): the workflow's identifier. */
export function uuidV7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Milliseconds since the epoch, from the host's clock. */
const clockOf = (h: Pick<WorkflowHost, 'now'>): number => (h.now ? h.now().getTime() : Date.now());

export class SendRefused extends Error {
  override name = 'SendRefused';
}

export interface ParticipantInput {
  /** The role placeholder this person fills. */
  role: string;
  name: string;
  email: string;
  kind?: ParticipantKind;
  /** Equal orders are parallel and ascending orders sequential (12 §6.1); default: the list order. */
  order?: number;
}

/** The role placeholders of a document: the roles its fields are assigned to (12 §3.1). */
export async function rolesOf(h: Pick<WorkflowHost, 'service'>, doc: string): Promise<string[]> {
  const fields = await h.service.listFields(doc);
  return [...new Set(fields.map((f) => f.assignee).filter((r): r is string => r !== null))];
}

/**
 * Binds the people to the roles and sends the document for completion. Only the document's owner
 * may; every role of the document needs a person, and every address must be one plain address. The
 * service checks the rest (a required field no role fills, an open suggestion, a rule that reads a
 * missing field) and answers `validation_failed` with the paths.
 */
export async function sendForCompletion(
  h: WorkflowHost,
  store: WorkflowStore,
  input: { doc: string; owner: string; participants: readonly ParticipantInput[] },
): Promise<WorkflowRecord> {
  if (h.catalogue.roleOf(input.doc, input.owner) !== 'owner')
    throw new SendRefused('Only the owner can send a document for completion.');
  if (store.get(input.doc) !== null)
    throw new SendRefused('This document has been sent for completion already.');
  const roles = await rolesOf(h, input.doc);
  if (roles.length === 0) throw new SendRefused('This document has no roles to fill.');
  const missing = roles.filter((r) => !input.participants.some((p) => p.role === r));
  if (missing.length > 0)
    throw new SendRefused(`Name a person for each role. Missing: ${missing.join(', ')}.`);
  const bindings: ParticipantBinding[] = input.participants.map((p, i) => {
    if (!roles.includes(p.role)) throw new SendRefused(`The document has no role ${p.role}.`);
    const name = p.name.trim();
    if (name === '' || name.length > 200) throw new SendRefused('Every person needs a name.');
    if (!isSendableAddress(p.email.trim()))
      throw new SendRefused(`${name}: the e-mail address is not one plain address.`);
    const kind = p.kind ?? 'filler';
    if (!PARTICIPANT_KINDS.includes(kind)) throw new SendRefused(`${name}: unknown kind ${kind}.`);
    return {
      id: `p${i + 1}`,
      sub: `ext-${randomBytes(9).toString('base64url')}`,
      name,
      email: p.email.trim(),
      roles: [p.role],
      kind,
      order: p.order ?? i + 1,
    };
  });
  const existing = await h.service.getWorkflow(input.doc);
  const resource: WorkflowView = {
    id: existing?.workflow.id ?? uuidV7(clockOf(h)),
    doc: input.doc,
    state: 'draft',
    rev: existing?.workflow.rev ?? 0,
    timeZone: 'UTC',
    // The service stores the opaque `sub` and the name, and no address (12 §6.3).
    participants: bindings.map((b) => ({
      id: b.id,
      roles: b.roles,
      kind: b.kind,
      order: b.order,
      sub: b.sub,
      name: b.name,
    })),
  };
  const written = await h.service.putWorkflow(
    input.doc,
    resource,
    existing ? existing.etag : '"0"',
    input.owner,
  );
  // The record is kept before the send: the service raises `participant_activated` while it
  // handles the send, and its delivery can reach the host's receiver before this call returns. An
  // event for a document without a record is ignored, so the invitation would be lost (UX-105).
  const record: WorkflowRecord = {
    doc: input.doc,
    workflow: written.id,
    owner: input.owner,
    sentAt: new Date(clockOf(h)).toISOString(),
    participants: bindings,
    state: 'sent',
  };
  await store.put(record);
  try {
    const sent = await h.service.sendWorkflow(input.doc, `refhost-send-${written.id}`, input.owner);
    if (sent.id !== record.workflow) {
      record.workflow = sent.id;
      await store.save();
    }
  } catch (e) {
    await store.remove(input.doc);
    throw e;
  }
  return record;
}

/** The host's page for a person who follows an invitation; the reference is not a token. */
export function invitationLink(publicUrl: string, reference: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/fill/${reference}`;
}

function titleOf(h: WorkflowHost, doc: string): string {
  return h.catalogue.get(doc)?.title ?? 'a document';
}

/** A fresh invitation reference for the participant; the older link stops working. */
async function renewInvitation(store: WorkflowStore, p: ParticipantBinding): Promise<string> {
  const reference = randomBytes(24).toString('base64url');
  p.invitation = sha256(reference);
  delete p.passcode;
  await store.save();
  return reference;
}

export interface EventDeps {
  host: WorkflowHost;
  store: WorkflowStore;
  mail: Mailer;
  /** The host's address as a reader reaches it. */
  publicUrl: string;
}

const dataOf = (event: ReceivedEvent): Record<string, unknown> =>
  typeof event.body['data'] === 'object' && event.body['data'] !== null
    ? (event.body['data'] as Record<string, unknown>)
    : {};

/**
 * What a workflow event causes in the host. Events for a document the host did not send are
 * ignored, as are events that name a participant the host does not know. A failure (a mail that
 * is refused, a PDF the service does not give) is thrown, so that the work queue records it.
 */
export async function handleWorkflowEvent(d: EventDeps, event: ReceivedEvent): Promise<void> {
  if (event.test || event.subject === null) return;
  const record = d.store.get(event.subject);
  if (record === null) return;
  const data = dataOf(event);
  const participantId = typeof data['participant'] === 'string' ? data['participant'] : null;
  switch (event.type) {
    case 'dep.workflow.participant_activated.v1':
      await notifyParticipants(d, record, event, participantId, 'invitation');
      return;
    case 'dep.workflow.reminder_due.v1':
      await notifyParticipants(d, record, event, participantId, 'reminder');
      return;
    // A participant's part ended (UX-106): the host mints no more tokens for the link, and the owner's page says so.
    case 'dep.workflow.participant_completed.v1':
    case 'dep.workflow.participant_declined.v1': {
      const p = record.participants.find((x) => x.id === participantId);
      if (p === undefined) return;
      p.finished = event.type.includes('declined') ? 'declined' : 'completed';
      if (p.finished === 'declined') record.state = 'declined';
      await d.store.save();
      return;
    }
    case 'dep.workflow.completed.v1':
      record.state = record.state === 'finalised' ? 'finalised' : 'completed';
      await d.store.save();
      return;
    case 'dep.workflow.finalised.v1':
      await fetchResults(d, record);
      return;
    default:
      return;
  }
}

async function notifyParticipants(
  d: EventDeps,
  record: WorkflowRecord,
  event: ReceivedEvent,
  participantId: string | null,
  kind: 'invitation' | 'reminder',
): Promise<void> {
  const who = record.participants.filter((p) => participantId === null || p.id === participantId);
  for (const p of who) {
    const reference = await renewInvitation(d.store, p);
    const title = titleOf(d.host, record.doc);
    await d.mail({
      to: p.email,
      subject:
        kind === 'invitation'
          ? `You are asked to complete: ${title}`
          : `A reminder to complete: ${title}`,
      text: [
        `Hello ${p.name},`,
        '',
        kind === 'invitation'
          ? `You are asked to complete the document "${title}".`
          : `The document "${title}" is still waiting for you.`,
        '',
        `Open it here: ${invitationLink(d.publicUrl, reference)}`,
        'The link does not sign you in. The page asks for a one-time passcode, which it sends to this address.',
        '',
        SIGNATURE_STATEMENT,
        '',
        'This message comes from the demonstration host. It is not a production deployment.',
        '',
      ].join('\n'),
      messageId: `${event.webhookId}.${p.id}@demo.example.test`,
    });
  }
}

/** Fetches the sealed PDF and the evidence bundle, and keeps them for the owner. */
async function fetchResults(d: EventDeps, record: WorkflowRecord): Promise<void> {
  const [pdf, evidence] = [
    await d.host.service.getSealedPdf(record.doc),
    await d.host.service.getEvidenceBundle(record.doc),
  ];
  const dir = join(d.host.config.dataDir, 'completed', record.doc);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'sealed.pdf'), pdf);
  await writeFile(join(dir, 'evidence.json'), evidence);
  record.state = 'finalised';
  record.results = {
    sealedPdf: 'sealed.pdf',
    evidence: 'evidence.json',
    fetchedAt: new Date(clockOf(d.host)).toISOString(),
  };
  await d.store.save();
}

/** A file kept for the owner: only the two names the host wrote, and only for the owner. */
export async function resultFile(
  h: WorkflowHost,
  store: WorkflowStore,
  doc: string,
  person: string,
  kind: 'sealed-pdf' | 'evidence',
): Promise<{ bytes: Uint8Array; type: string; filename: string } | null> {
  const record = store.get(doc);
  if (record === null || record.results === undefined) return null;
  if (h.catalogue.roleOf(doc, person) !== 'owner') return null;
  const dir = join(h.config.dataDir, 'completed', doc);
  return kind === 'sealed-pdf'
    ? {
        bytes: new Uint8Array(await readFile(join(dir, 'sealed.pdf'))),
        type: 'application/pdf',
        filename: 'sealed.pdf',
      }
    : {
        bytes: new Uint8Array(await readFile(join(dir, 'evidence.json'))),
        type: 'application/json',
        filename: 'evidence.json',
      };
}

/** How long a passcode lasts and how often it may be tried (the demo's own choice). */
export const PASSCODE_LIFETIME_MS = 10 * 60 * 1000;
export const PASSCODE_ATTEMPTS = 5;

/**
 * The person asks for a passcode through the invitation. The host mails six digits to the address
 * it holds for the participant; the page never shows them. Null for a reference nobody holds.
 */
export async function startPasscode(
  d: EventDeps,
  reference: string,
): Promise<{ name: string } | null> {
  const found = d.store.byInvitation(reference);
  if (found === null) return null;
  const { participant: p, record } = found;
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const now = clockOf(d.host);
  p.passcode = {
    hash: sha256(`${p.invitation}:${code}`),
    expiresAt: now + PASSCODE_LIFETIME_MS,
    attempts: 0,
  };
  await d.store.save();
  await d.mail({
    to: p.email,
    subject: `Your passcode for: ${titleOf(d.host, record.doc)}`,
    text: `Hello ${p.name},\n\nYour one-time passcode is ${code}. It works once and lapses in ${PASSCODE_LIFETIME_MS / 60000} minutes.\n\nThis message comes from the demonstration host.\n`,
    messageId: `${randomUUID()}@demo.example.test`,
  });
  return { name: p.name };
}

export type PasscodeResult =
  | { ok: true; token: string; expiresAt: string; doc: string; participant: string }
  | { ok: false; reason: 'unknown' | 'none' | 'expired' | 'wrong' | 'locked' };

/**
 * The person enters the passcode. A right one is spent, and the host mints the participant's token:
 * role `filler`, the opaque `sub`, `wfp` with the participant's identifier, `amr` `["otp"]` and
 * `auth_time` now, which is what the host asserts about how it authenticated them. A wrong one
 * counts against the limit; at the limit the passcode is gone and a new one must be asked for.
 */
export async function verifyPasscode(
  d: EventDeps,
  reference: string,
  code: string,
): Promise<PasscodeResult> {
  const found = d.store.byInvitation(reference);
  if (found === null) return { ok: false, reason: 'unknown' };
  const { participant: p, record } = found;
  const pass = p.passcode;
  if (pass === undefined) return { ok: false, reason: 'none' };
  const now = clockOf(d.host);
  if (now > pass.expiresAt) {
    delete p.passcode;
    await d.store.save();
    return { ok: false, reason: 'expired' };
  }
  const given = Buffer.from(sha256(`${p.invitation}:${code.replace(/\s+/g, '')}`));
  const wanted = Buffer.from(pass.hash);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    pass.attempts += 1;
    if (pass.attempts >= PASSCODE_ATTEMPTS) delete p.passcode;
    await d.store.save();
    return { ok: false, reason: pass.attempts >= PASSCODE_ATTEMPTS ? 'locked' : 'wrong' };
  }
  delete p.passcode;
  await d.store.save();
  const issued = await issueParticipantToken(d, record, p, Math.floor(now / 1000));
  return { ok: true, ...issued, doc: record.doc, participant: p.id };
}

/**
 * The participant's token: role `filler`, the opaque `sub`, `wfp` with the participant's
 * identifier, `amr` `["otp"]` and `auth_time` as the host asserts them. `authTime` is when the
 * passcode was accepted, not when the token is minted, so a renewal keeps what was true.
 */
export function issueParticipantToken(
  d: Pick<EventDeps, 'host'>,
  record: WorkflowRecord,
  p: ParticipantBinding,
  authTime: number,
): Promise<{ token: string; expiresAt: string }> {
  return d.host.tokens.issue({
    user: { sub: p.sub, name: p.name, groups: [], about: '' },
    doc: record.doc,
    role: 'filler',
    participant: { id: p.id, amr: ['otp'], authTime },
  });
}
