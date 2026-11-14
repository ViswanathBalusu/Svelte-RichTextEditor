/**
 * Helpers shared by the contract cases: harness lifetime, joining a document the way 05 §5.2
 * describes (content over REST, then the channel with `resume`), and submitting commits.
 */
import { uuid7 } from '@docedit/model';
import type { Backend, SyncChannel } from '../ports/core.ts';
import type { Ack, Content, DocRole, Resume, Step } from '../ports/types.ts';
import { contractDocument, LEGAL_GRANT, ROLES, USERS } from './fixtures.ts';
import type { ContractHarness, ContractOptions, ContractUser, HarnessFactory } from './harness.ts';
import { Recorder } from './recorder.ts';

export interface Member {
  backend: Backend;
  channel: SyncChannel;
  rec: Recorder;
  /** The content read before opening the channel. */
  content: Content;
  /** The highest seq this member has seen: content, commits and its own acknowledgements. */
  seq(): number;
}

export type Who = keyof typeof USERS;

export async function withHarness(
  factory: HarnessFactory,
  fn: (h: ContractHarness) => Promise<void>,
): Promise<void> {
  const h = await factory();
  try {
    await fn(h);
  } finally {
    await h.dispose();
  }
}

/** Creates the contract document with the grant that opens the restricted region to `group:legal`. */
export function createDoc(h: ContractHarness): Promise<string> {
  return h.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
}

export async function connect(
  h: ContractHarness,
  user: ContractUser,
  docs: Readonly<Record<string, DocRole>>,
): Promise<Backend> {
  const b = await h.backend(user, docs);
  await b.connect();
  return b;
}

/** Joins as one of the cast: content at the head over REST, then the channel resumed at its seq. */
export async function join(
  h: ContractHarness,
  opts: ContractOptions,
  docId: string,
  who: Who,
  backend?: Backend,
): Promise<Member> {
  const b = backend ?? (await connect(h, USERS[who], { [docId]: ROLES[who] }));
  const content = await b.sync.loadContent(docId);
  const channel = await b.sync.open(docId, { resume: resumeFrom(content) });
  return member(b, channel, content, opts);
}

/**
 * A resume at the `seq` of content read over REST, with the content's view token when it has one
 * (G101; D70): the confirmed document is that content, so its view is the one to echo.
 */
export function resumeFrom(content: Content, inflight?: string): Resume {
  const r: Resume = { seq: content.seq, incarnation: content.incarnation };
  if (inflight !== undefined) r.inflight = inflight;
  if (content.view !== undefined) r.view = content.view;
  return r;
}

/** Opens a channel with an explicit resume (or none) on a connected backend. */
export async function openWith(
  b: Backend,
  docId: string,
  opts: ContractOptions,
  resume?: Resume,
): Promise<Member> {
  const content = await b.sync.loadContent(docId);
  const channel = await b.sync.open(docId, resume ? { resume } : {});
  return member(b, channel, content, opts);
}

function member(
  backend: Backend,
  channel: SyncChannel,
  content: Content,
  opts: ContractOptions,
): Member {
  const rec = new Recorder(channel, opts);
  return {
    backend,
    channel,
    rec,
    content,
    seq: () =>
      Math.max(
        content.seq,
        channel.opened.catchUp === 'reload' ? channel.opened.head : 0,
        ...rec.log.map((d) =>
          d.kind === 'commits'
            ? Math.max(...d.value.map((c) => c.seq))
            : d.kind === 'ack'
              ? d.value.seq
              : d.kind === 'reset'
                ? d.value.seq
                : 0,
        ),
      ),
  };
}

/** Submits steps on the member's confirmed seq (or `base`) and records the acknowledgement. */
export async function submit(
  m: Member,
  steps: Step[],
  base?: number,
  id: string = uuid7(),
): Promise<Ack> {
  const ack = await m.channel.submit({ id, base: base ?? m.seq(), steps });
  m.rec.ack(ack);
  return ack;
}

export const newId = (): string => uuid7();

/**
 * A resume after an earlier channel: its incarnation and, when it had one, its `view`, which the
 * client echoes because its confirmed document came from that channel (ADR 0019; D28).
 */
export function resumeAfter(channel: SyncChannel, seq: number, inflight?: string): Resume {
  const r: Resume = { seq, incarnation: channel.opened.incarnation };
  if (inflight !== undefined) r.inflight = inflight;
  if (channel.opened.view !== undefined) r.view = channel.opened.view;
  return r;
}

/** Lets queued deliveries happen, then a little more, so that "nothing else arrived" can be checked. */
export function quiet(opts: ContractOptions): Promise<void> {
  return opts.sleep(opts.quietMs ?? 30);
}
